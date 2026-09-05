import { waitForDaemon } from "./test-wait-for.js"
import { mkdtemp, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import {
  demoWorkspace,
  protocolVersion,
  workspaceSnapshotSchema,
  type SessionTransferCoverage,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { DomovoiDaemon } from "./server.js"
import { MachinePairingRequiredError } from "./machine-socket.js"
import {
  createSessionTransferPackage,
  prepareSessionTransferIntent,
} from "./session-transfer-package.js"
import {
  freezeSourceSessionTransfer,
  markSourceTransferReconciliationFailure,
  recoverUnconfirmedSourceTransfer,
  stageOutgoingSessionTransferPackage,
  stageSourceSessionCheckpoint,
} from "./session-transfer-source.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { TerminalProcess } from "./terminal.js"
import { FileTransferTransactions } from "./transfer-transactions.js"
import type { WorkspaceService } from "./workspace.js"

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []
const sourceMachineId = `machine-${"a".repeat(32)}`
const targetMachineId = `machine-${"b".repeat(32)}`
const baseCommit = "c".repeat(40)
const checkpointCommit = "d".repeat(40)

function testAuthToken(label: string): string {
  return createHash("sha256").update(label).digest("base64url")
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(scratchDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

function targetSnapshot(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.machine.id = targetMachineId
  snapshot.project = {
    ...snapshot.project!,
    id: "project-target",
    machineId: targetMachineId,
    path: "/target/project",
  }
  snapshot.sessions = []
  snapshot.thread = []
  snapshot.artifacts = []
  snapshot.workingPlans = []
  snapshot.annotations = []
  snapshot.approvals = []
  snapshot.activeSessionId = null
  return snapshot
}

async function transferFixture() {
  const source = structuredClone(demoWorkspace)
  source.machine.id = sourceMachineId
  source.project!.machineId = sourceMachineId
  const session = source.sessions.find((candidate) => candidate.state === "idle")!
  session.runtime = {
    provider: "claude-code",
    model: "claude-opus-5",
    reasoning: "high",
    permissionMode: "build",
    auto: false,
  }
  session.workspacePath = "/source/session"
  session.baseCommit = baseCommit
  session.ownershipGeneration = 1
  delete session.providerThreadId
  source.sessions = [session]
  source.activeSessionId = session.id
  source.thread = source.thread.filter((item) => item.sessionId === session.id)
  source.artifacts = []
  source.workingPlans = []
  source.annotations = []
  source.approvals = []
  const intent = await prepareSessionTransferIntent({
    snapshot: source,
    sessionId: session.id,
    usage: [],
    sourceMachineId,
    targetMachineId,
    sourceProjectId: source.project!.id,
    targetProjectId: "project-target",
    lineageCommit: baseCommit,
    sourceHeadCommit: baseCommit,
    worktreeDigest: `sha256:${"e".repeat(64)}`,
    method: "git-bundle",
    readIgnoredArtifactSource: async () => undefined,
    readAnnotationCrop: async () => { throw new Error("no crops") },
  })
  const packaged = createSessionTransferPackage(intent, {
    transferId: `transfer-${"f".repeat(32)}`,
    checkpointCommit,
    repository: { method: "git-bundle", bytes: Buffer.from("repository") },
    createdAt: "2026-09-03T22:00:00.000Z",
  })
  return { source, intent, packaged }
}

async function packagedTransfer() {
  return (await transferFixture()).packaged
}

async function stagedTransferFixture() {
  const fixture = await transferFixture()
  const staged = stageSourceSessionCheckpoint(
    freezeSourceSessionTransfer(
      fixture.source,
      fixture.intent,
      fixture.packaged.manifest.transferId,
      "2026-09-03T22:00:00.000Z",
      { client: "desktop", clientId: "studio-mac" },
    ),
    fixture.packaged.manifest,
  )
  return { ...fixture, staged }
}

function rpc(socket: WebSocket) {
  let id = 0
  return (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    const response = new Promise<Record<string, unknown>>((resolve) => {
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        if (message.id !== requestId) return
        socket.off("message", receive)
        resolve(message as Record<string, unknown>)
      }
      socket.on("message", receive)
    })
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    return response
  }
}

async function openMachine(
  daemon: DomovoiDaemon,
  store: SqliteWorkspaceStore,
  machineId = sourceMachineId,
): Promise<{ socket: WebSocket; hello: Record<string, unknown> }> {
  const paired = store.devices.pair({
    label: "peer daemon",
    binding: { kind: "machine", machineId },
  })
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
    headers: { authorization: `Bearer ${paired.token}` },
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  const call = rpc(socket)
  const hello = await call("system.hello", {
    client: "machine",
    clientVersion: "0.0.1",
    protocolVersion,
  })
  return { socket, hello }
}

async function openClient(
  daemon: DomovoiDaemon,
  clientId?: string,
  client: "desktop" | "web" = "desktop",
): Promise<WebSocket> {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  await rpc(socket)("system.hello", {
    client,
    ...(clientId ? { clientId } : {}),
    clientVersion: "0.0.1",
    protocolVersion,
  })
  return socket
}

async function preparedTargetTransfer() {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-rpc-"))
  scratchDirectories.push(scratch)
  const transactions = new FileTransferTransactions(join(scratch, "transactions"))
  const store = new SqliteWorkspaceStore(":memory:", targetSnapshot())
  const daemon = new DomovoiDaemon({
    port: 0,
    store,
    authToken: testAuthToken("correct-horse-battery-staple"),
    workspaceService: {
      inspect: async (path: string) => ({
        root: path,
        name: path === "/target/project" ? "project" : "other",
        branch: "main",
        head: baseCommit,
      }),
      createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
      removeSessionWorkspace: async () => {},
      checkpoint: async () => ({ commit: checkpointCommit, changedFiles: [] }),
      restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
      projectHasLineage: async () => true,
      restoreSessionFromBundle: async (_path: string, sessionId: string) => ({
        path: `/target/${sessionId}`,
        branch: `domovoi/${sessionId}`,
        baseCommit: checkpointCommit,
      }),
    } satisfies WorkspaceService,
    transferTransactions: transactions,
    artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
  })
  running.push(daemon)
  await daemon.start()
  const { socket } = await openMachine(daemon, store)
  const call = rpc(socket)
  const packaged = await packagedTransfer()

  await expect(call("transfer.preflight", {
    contractVersion: packaged.manifest.version,
    sessionId: packaged.manifest.sessionId,
    sourceMachineId,
    sourceProjectId: packaged.manifest.project.sourceProjectId,
    lineageCommit: baseCommit,
    ownershipGeneration: packaged.manifest.ownership.fromGeneration,
    method: packaged.manifest.repository.method,
    coverage: packaged.manifest.coverage,
    initiatedByClient: "desktop",
  })).resolves.toMatchObject({
    result: { allowed: true, targetProjectId: "project-target" },
  })
  await expect(call("transfer.prepare", {
    manifest: packaged.manifest,
    manifestDigest: packaged.manifestDigest,
    initiatedByClient: "desktop",
  })).resolves.toMatchObject({
    result: { state: "receiving" },
  })
  for (const entry of packaged.members) {
    await call("transfer.member", {
      transferId: packaged.manifest.transferId,
      memberId: entry.member.memberId,
      sequence: 0,
      bytes: entry.bytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })
  }
  return {
    call,
    daemon,
    packaged,
    socket,
    store,
    transactions,
    commitParams: {
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      initiatedByClient: "desktop",
    },
  }
}

describe("transactional session transfer RPC", () => {
  it("requires a hello identity before an authenticated socket can call RPCs", async () => {
    const { source } = await transferFixture()
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", source),
      authToken: testAuthToken("correct-horse-battery-staple"),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const address = daemon.address!
    const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${daemon.authToken}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    const call = rpc(socket)

    await expect(call("workspace.get", {})).resolves.toMatchObject({
      error: { code: -32001, message: "Connection identity is required" },
    })
    await expect(call("session.send", {
      sessionId: source.sessions[0]!.id,
      prompt: "run without an actor",
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32001, message: "Connection identity is required" },
    })
    socket.close()
  })

  it("does not disclose workspace state or client broadcasts to a machine connection", async () => {
    const snapshot = structuredClone(demoWorkspace)
    snapshot.machine.id = targetMachineId
    snapshot.project!.machineId = targetMachineId
    const store = new SqliteWorkspaceStore(":memory:", snapshot)
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const address = daemon.address!
    const { socket: machineSocket, hello } = await openMachine(daemon, store)
    expect(hello.result).toMatchObject({
      project: null,
      activeSessionId: null,
      sessions: [],
      thread: [],
      artifacts: [],
      annotations: [],
      workingPlans: [],
      approvals: [],
      approvalRules: [],
      skillEnablements: [],
    })

    const notifications: string[] = []
    machineSocket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: unknown; method?: unknown }
      if (message.id === undefined && typeof message.method === "string") {
        notifications.push(message.method)
      }
    })
    const unidentifiedSocket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
      headers: { authorization: `Bearer ${daemon.authToken}` },
    })
    await new Promise<void>((resolve, reject) => {
      unidentifiedSocket.once("open", resolve)
      unidentifiedSocket.once("error", reject)
    })
    const unidentifiedNotifications: string[] = []
    unidentifiedSocket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: unknown; method?: unknown }
      if (message.id === undefined && typeof message.method === "string") {
        unidentifiedNotifications.push(message.method)
      }
    })
    const clientSocket = await openClient(daemon)
    const annotation = snapshot.annotations[0]!
    await rpc(clientSocket)("annotation.setStatus", {
      annotationId: annotation.id,
      status: annotation.status === "open" ? "resolved" : "open",
      client: "desktop",
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(notifications).toEqual([])
    expect(unidentifiedNotifications).toEqual([])
    clientSocket.close()
    unidentifiedSocket.close()
    machineSocket.close()
  })

  it("requires a matching authenticated client to preview or move a source", async () => {
    const { source } = await transferFixture()
    const store = new SqliteWorkspaceStore(":memory:", source)
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    const connectToMachine = vi.fn(async () => ({
      call: async () => ({
        allowed: true,
        targetProjectId: "project-target",
        lineageCommit: baseCommit,
      }),
      close: () => {},
    }))
    const checkpoint = vi.fn(async () => ({ commit: checkpointCommit, changedFiles: [] }))
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      workspaceService: {
        inspect: async () => ({
          root: source.project!.path,
          name: source.project!.name,
          branch: source.project!.branch,
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint,
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async () => ({
          headCommit: baseCommit,
          digest: `sha256:${"e".repeat(64)}`,
        }),
        readIgnoredArtifactSource: async () => undefined,
        bundleSession: async (_worktreePath, bundlePath) => ({
          path: bundlePath,
          commit: checkpointCommit,
          incremental: false,
        }),
      },
      readTransferBundle: async () => Buffer.from("repository"),
      connectToMachine,
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const request = {
      sessionId: source.sessions[0]!.id,
      targetMachineId,
      initiatedByClient: "desktop",
    }

    const { socket: machineSocket } = await openMachine(daemon, store, targetMachineId)
    const machineCall = rpc(machineSocket)
    for (const [method, params] of [
      ["workspace.get", {}],
      ["session.send", {
        sessionId: source.sessions[0]!.id,
        prompt: "run outside the transfer role",
        client: "desktop",
      }],
      ["session.archive", { sessionId: source.sessions[0]!.id, client: "desktop" }],
      ["system.emergencyStop", { client: "desktop" }],
    ] as const) {
      await expect(machineCall(method, params)).resolves.toMatchObject({
        error: { code: -32001, message: "Machine connections may only use transfer RPCs" },
      })
    }
    await expect(machineCall("session.transferPreview", request)).resolves.toMatchObject({
      error: { code: -32001 },
    })
    const webSocket = await openClient(daemon, undefined, "web")
    await expect(rpc(webSocket)("session.transferPreview", request)).resolves.toMatchObject({
      error: { code: -32602 },
    })
    expect(connectToMachine).not.toHaveBeenCalled()

    const desktopSocket = await openClient(daemon)
    const preview = await rpc(desktopSocket)("session.transferPreview", request)
    const approved = preview.result as { contractVersion: 1; intentDigest: string }
    expect(connectToMachine).toHaveBeenCalledOnce()
    connectToMachine.mockClear()
    const transfer = {
      ...request,
      contractVersion: approved.contractVersion,
      intentDigest: approved.intentDigest,
    }
    await expect(machineCall("session.transfer", transfer)).resolves.toMatchObject({
      error: { code: -32001 },
    })
    await expect(rpc(webSocket)("session.transfer", transfer)).resolves.toMatchObject({
      error: { code: -32602 },
    })
    expect(connectToMachine).not.toHaveBeenCalled()
    expect(checkpoint).not.toHaveBeenCalled()
    machineSocket.close()
    webSocket.close()
    desktopSocket.close()
  })

  it("prunes incoming and outgoing transfer journals before listening", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-retention-startup-"))
    scratchDirectories.push(scratch)
    const incoming = new FileTransferTransactions(join(scratch, "incoming"))
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    const pruneIncoming = vi.spyOn(incoming, "pruneExpired")
    const pruneOutgoing = vi.spyOn(outgoing, "pruneExpired")
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", targetSnapshot()),
      authToken: testAuthToken("correct-horse-battery-staple"),
      transferTransactions: incoming,
      outgoingTransferTransactions: outgoing,
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    expect(pruneIncoming).toHaveBeenCalledOnce()
    expect(pruneOutgoing).toHaveBeenCalledOnce()
  })

  it("reconciles the worktree head before thawing a preparing source after restart", async () => {
    const { source, intent, packaged } = await transferFixture()
    const frozen = freezeSourceSessionTransfer(
      source,
      intent,
      packaged.manifest.transferId,
      "2026-09-03T22:00:00.000Z",
      { client: "desktop", clientId: "studio-mac" },
    )
    const store = new SqliteWorkspaceStore(":memory:", frozen)
    const transferFingerprint = vi.fn(async () => ({
      headCommit: checkpointCommit,
      digest: `sha256:${"0".repeat(64)}`,
    }))
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      workspaceService: {
        inspect: async () => ({
          root: source.project!.path,
          name: source.project!.name,
          branch: source.project!.branch,
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => ({ commit: checkpointCommit, changedFiles: [] }),
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint,
      },
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await waitForDaemon(() => expect(store.load().sessions[0]?.state).toBe("idle"))
    expect(transferFingerprint).toHaveBeenCalledWith(
      source.sessions[0]!.workspacePath,
      expect.any(AbortSignal),
    )
    expect(store.load().sessions[0]).toMatchObject({
      state: "idle",
      baseCommit: checkpointCommit,
    })
  })

  it("finishes a committed staged transfer after the source restarts", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-restart-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    await stageOutgoingSessionTransferPackage(outgoing, packaged)
    let statusCalls = 0
    const remoteCall = vi.fn(async (method: string) => {
      if (method !== "transfer.status") throw new Error(`Unexpected ${method}`)
      statusCalls += 1
      if (statusCalls === 1) throw new Error("target temporarily unavailable")
      return {
        state: "committed",
        transferId: packaged.manifest.transferId,
        workspacePath: `/target/${packaged.manifest.sessionId}`,
        checkpointCommit,
        ownershipGeneration: 2,
      }
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: outgoing,
      sessionTransferRetryMs: 10,
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await waitForDaemon(() => expect(store.load().sessions[0]?.state).toBe("transferred"))
    expect(remoteCall).toHaveBeenCalledTimes(2)
    expect(store.load().sessions[0]).toMatchObject({
      state: "transferred",
      ownershipGeneration: 2,
      runtime: { auto: false },
      transfer: {
        phase: "transferred",
        transferId: packaged.manifest.transferId,
        manifestDigest: packaged.manifestDigest,
      },
    })
    await waitForDaemon(async () => {
      await expect(outgoing.status(
        packaged.manifest.transferId,
        packaged.manifestDigest,
      )).resolves.toMatchObject({ state: "unknown" })
    })
  })

  it("thaws a restarted source only when the target authoritatively has no transfer", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-restart-empty-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const remoteCall = vi.fn(async (method: string) => {
      if (method !== "transfer.status") throw new Error(`Unexpected ${method}`)
      return { state: "unknown", transferId: packaged.manifest.transferId }
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await waitForDaemon(() => expect(store.load().sessions[0]?.state).toBe("idle"))
    expect(remoteCall).toHaveBeenCalledOnce()
    expect(store.load().sessions[0]).toMatchObject({
      state: "idle",
      ownershipGeneration: 1,
      runtime: { auto: false },
    })
    expect(store.load().sessions[0]).not.toHaveProperty("transfer")
  })

  it("keeps a restarted source frozen on a status for another transfer", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-wrong-status-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const remoteCall = vi.fn(async () => ({
      state: "aborted",
      transferId: `transfer-${"0".repeat(32)}`,
    }))
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()
    await waitForDaemon(() => expect(remoteCall).toHaveBeenCalledOnce())

    expect(store.load().sessions[0]).toMatchObject({
      state: "transferring",
      transfer: { transferId: packaged.manifest.transferId },
    })
  })

  it("keeps recovery frozen when a retry or abort response names another transfer", async () => {
    for (const scenario of ["commit", "abort"] as const) {
      const scratch = await mkdtemp(join(tmpdir(), `domovoi-transfer-wrong-${scenario}-`))
      scratchDirectories.push(scratch)
      const { staged, packaged } = await stagedTransferFixture()
      const store = new SqliteWorkspaceStore(":memory:", staged)
      const remoteCall = vi.fn(async (method: string) => {
        if (method === "transfer.status") {
          return scenario === "commit"
            ? {
                state: "failed",
                transferId: packaged.manifest.transferId,
                reason: "persistence-failed",
              }
            : { state: "prepared", transferId: packaged.manifest.transferId }
        }
        expect(method).toBe(scenario === "commit" ? "transfer.commit" : "transfer.abort")
        return {
          state: "refused",
          transferId: `transfer-${"0".repeat(32)}`,
          reason: "session-state-changed",
        }
      })
      const daemon = new DomovoiDaemon({
        port: 0,
        store,
        authToken: testAuthToken("correct-horse-battery-staple"),
        outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
        connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
        errorSink: () => {},
        artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
      })
      running.push(daemon)

      await daemon.start()
      await waitForDaemon(() => expect(remoteCall).toHaveBeenCalledTimes(2))
      expect(store.load().sessions[0]).toMatchObject({
        state: "transferring",
        transfer: { transferId: packaged.manifest.transferId },
      })
      await daemon.stop()
      running.splice(running.indexOf(daemon), 1)
    }
  })

  it("resumes a staged package after both daemons lost volatile transfer state", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-restart-resume-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    const target = new FileTransferTransactions(join(scratch, "target"))
    await stageOutgoingSessionTransferPackage(outgoing, packaged)
    const remoteCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "transfer.status") {
        return target.status(String(params.transferId), String(params.manifestDigest))
      }
      if (method === "transfer.prepare") {
        return target.prepare(params.manifest as never, String(params.manifestDigest))
      }
      if (method === "transfer.member") return target.acceptMember(params as never)
      if (method === "transfer.commit") {
        return {
          state: "committed",
          transferId: packaged.manifest.transferId,
          workspacePath: `/target/${packaged.manifest.sessionId}`,
          checkpointCommit,
          ownershipGeneration: 2,
        }
      }
      throw new Error(`Unexpected ${method}`)
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: outgoing,
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await waitForDaemon(() => expect(store.load().sessions[0]?.state).toBe("transferred"))
    expect(remoteCall.mock.calls.map(([method]) => method)).toEqual([
      "transfer.status",
      "transfer.status",
      "transfer.prepare",
      ...packaged.members.map(() => "transfer.member"),
      "transfer.commit",
    ])
    expect(store.load().sessions[0]).toMatchObject({
      state: "transferred",
      ownershipGeneration: 2,
    })
  })

  it("aborts a partial target before thawing when the source package is gone", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-restart-abort-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    const target = new FileTransferTransactions(join(scratch, "target"))
    await target.prepare(packaged.manifest, packaged.manifestDigest)
    const remoteCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "transfer.status") {
        return target.status(String(params.transferId), String(params.manifestDigest))
      }
      if (method === "transfer.abort") {
        return target.abort(String(params.transferId), String(params.manifestDigest))
      }
      throw new Error(`Unexpected ${method}`)
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: outgoing,
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await waitForDaemon(() => expect(store.load().sessions[0]?.state).toBe("idle"))
    expect(remoteCall.mock.calls.map(([method]) => method)).toEqual([
      "transfer.status",
      "transfer.abort",
    ])
    expect(store.load().sessions[0]).toMatchObject({ state: "idle", ownershipGeneration: 1 })
    expect(store.load().sessions[0]).not.toHaveProperty("transfer")
  })

  it("retries a target commit that was interrupted during recovery", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-restart-recovery-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const remoteCall = vi.fn(async (method: string) => {
      if (method === "transfer.status") {
        return {
          state: "failed",
          transferId: packaged.manifest.transferId,
          reason: "persistence-failed",
        }
      }
      if (method === "transfer.commit") {
        return {
          state: "committed",
          transferId: packaged.manifest.transferId,
          workspacePath: `/target/${packaged.manifest.sessionId}`,
          checkpointCommit,
          ownershipGeneration: 2,
        }
      }
      throw new Error(`Unexpected ${method}`)
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await waitForDaemon(() => expect(store.load().sessions[0]?.state).toBe("transferred"))
    expect(remoteCall.mock.calls.map(([method]) => method)).toEqual([
      "transfer.status",
      "transfer.commit",
    ])
    expect(store.load().sessions[0]).toMatchObject({
      state: "transferred",
      ownershipGeneration: 2,
    })
  })

  it("requires an explicit operator claim before recovering an unreachable source", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-source-recovery-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    await stageOutgoingSessionTransferPackage(outgoing, packaged)
    const connectToMachine = vi.fn(async () => {
      throw new Error("target is unreachable")
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: outgoing,
      connectToMachine,
      errorSink: () => {},
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    await waitForDaemon(() => expect(connectToMachine).toHaveBeenCalledOnce())
    expect(store.load().sessions[0]).toMatchObject({
      state: "transferring",
      transfer: {
        package: {
          state: "staged",
          reconciliation: {
            state: "ownership-unconfirmed",
            reason: "target-unreachable",
            firstFailedAt: expect.any(String),
            lastFailedAt: expect.any(String),
            attemptCount: 1,
            recoveryAction: "confirm-source-recovery",
          },
        },
      },
    })
    expect(JSON.stringify(store.load())).not.toContain("target is unreachable")
    const socket = await openClient(daemon, "studio-mac")

    const recovered = await rpc(socket)("session.transferRecoverSource", {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      confirmation: "target-does-not-have-session",
      initiatedByClient: "desktop",
    })

    expect(recovered.result).toMatchObject({
      sessions: [{
        id: packaged.manifest.sessionId,
        state: "idle",
        ownershipGeneration: 1,
        sourceRecovery: {
          transferId: packaged.manifest.transferId,
          targetMachineId,
          generation: 1,
          manifestDigest: packaged.manifestDigest,
          decidedBy: { client: "desktop", clientId: "studio-mac" },
        },
      }],
      thread: expect.arrayContaining([expect.objectContaining({
        sessionId: packaged.manifest.sessionId,
        kind: "system",
        body: "Source ownership recovered without target confirmation.",
      })]),
    })
    await expect(outgoing.status(
      packaged.manifest.transferId,
      packaged.manifestDigest,
    )).resolves.toMatchObject({ state: "unknown" })
    socket.close()
  })

  it("records repeated pairing failures without persisting provider error text", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-pairing-evidence-"))
    scratchDirectories.push(scratch)
    const { staged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const connectToMachine = vi.fn(async () => {
      throw new MachinePairingRequiredError()
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      connectToMachine,
      sessionTransferRetryMs: 10,
      errorSink: () => {},
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()
    await waitForDaemon(() => {
      const lifecycle = store.load().sessions[0]?.transfer
      if (lifecycle?.phase !== "transferring" || lifecycle.package.state !== "staged") {
        throw new Error("Expected a staged transfer")
      }
      expect(lifecycle.package.reconciliation?.attemptCount).toBeGreaterThanOrEqual(2)
    })

    const lifecycle = store.load().sessions[0]?.transfer
    if (lifecycle?.phase !== "transferring" || lifecycle.package.state !== "staged") {
      throw new Error("Expected a staged transfer")
    }
    expect(lifecycle.package.reconciliation).toMatchObject({
      reason: "target-pairing-required",
      firstFailedAt: expect.any(String),
      lastFailedAt: expect.any(String),
      recoveryAction: "confirm-source-recovery",
    })
    expect(Date.parse(lifecycle.package.reconciliation!.lastFailedAt)).toBeGreaterThanOrEqual(
      Date.parse(lifecycle.package.reconciliation!.firstFailedAt),
    )
    expect(JSON.stringify(store.load())).not.toContain("Machine pairing is required")
  })

  it("distinguishes a target status deadline from an unreachable target", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-timeout-evidence-"))
    scratchDirectories.push(scratch)
    const { staged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      sessionTransferTimeoutMs: 10,
      connectToMachine: async (_machineId, signal) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
      errorSink: () => {},
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()
    await waitForDaemon(() => {
      const lifecycle = store.load().sessions[0]?.transfer
      if (lifecycle?.phase !== "transferring" || lifecycle.package.state !== "staged") {
        throw new Error("Expected a staged transfer")
      }
      expect(lifecycle.package.reconciliation?.reason).toBe("target-timeout")
    })
  })

  it("does not recover a source from a status for another transfer", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-wrong-recovery-status-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    await stageOutgoingSessionTransferPackage(outgoing, packaged)
    let calls = 0
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: outgoing,
      connectToMachine: async () => ({
        call: async () => {
          calls += 1
          if (calls === 1) throw new Error("startup status unavailable")
          return { state: "unknown", transferId: `transfer-${"0".repeat(32)}` }
        },
        close: () => {},
      }),
      errorSink: () => {},
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    await waitForDaemon(() => expect(calls).toBe(1))
    const socket = await openClient(daemon, "studio-mac")

    const response = await rpc(socket)("session.transferRecoverSource", {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      confirmation: "target-does-not-have-session",
      initiatedByClient: "desktop",
    })

    expect(response).toMatchObject({
      error: { code: -32602, message: "Target transfer identity changed" },
    })
    expect(store.load().sessions[0]).toMatchObject({
      state: "transferring",
      transfer: {
        transferId: packaged.manifest.transferId,
        package: {
          reconciliation: { reason: "target-unreachable", attemptCount: 1 },
        },
      },
    })
    socket.close()
  })

  it("clears source recovery evidence when the target answers authoritatively", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-recovery-cleared-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    await stageOutgoingSessionTransferPackage(outgoing, packaged)
    let calls = 0
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: outgoing,
      connectToMachine: async () => ({
        call: async () => {
          calls += 1
          if (calls === 1) throw new Error("startup status unavailable")
          return { state: "receiving", transferId: packaged.manifest.transferId }
        },
        close: () => {},
      }),
      errorSink: () => {},
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    await waitForDaemon(() => {
      const transfer = store.load().sessions[0]?.transfer
      expect(
        transfer?.phase === "transferring" && transfer.package.state === "staged"
          ? transfer.package.reconciliation
          : undefined,
      ).toBeDefined()
    })
    const socket = await openClient(daemon, "studio-mac")

    const response = await rpc(socket)("session.transferRecoverSource", {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      confirmation: "target-does-not-have-session",
      initiatedByClient: "desktop",
    })

    expect(response).toMatchObject({
      error: {
        code: -32602,
        message: "The target still holds transfer state, so source recovery was refused",
      },
    })
    const current = store.load().sessions[0]
    expect(current).toMatchObject({ state: "transferring" })
    if (current?.transfer?.phase !== "transferring" || current.transfer.package.state !== "staged") {
      throw new Error("Expected a staged source transfer")
    }
    expect(current.transfer.package).not.toHaveProperty("reconciliation")
    socket.close()
  })

  it("freezes the claimant when a recovered target later proves it owns the session", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-owner-conflict-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const recovered = recoverUnconfirmedSourceTransfer(
      markSourceTransferReconciliationFailure(staged, {
        sessionId: packaged.manifest.sessionId,
        transferId: packaged.manifest.transferId,
        reason: "target-unreachable",
        failedAt: "2026-09-03T22:09:00.000Z",
      }),
      {
        sessionId: packaged.manifest.sessionId,
        transferId: packaged.manifest.transferId,
        client: "desktop",
        clientId: "studio-mac",
        recoveredAt: "2026-09-03T22:10:00.000Z",
      },
    )
    const approval = structuredClone(demoWorkspace.approvals[0]!)
    approval.sessionId = packaged.manifest.sessionId
    recovered.approvals = [approval]
    recovered.workingPlans = [{
      sessionId: packaged.manifest.sessionId,
      revision: 1,
      structureRevision: 1,
      steps: [{
        id: "plan-step-waiting",
        text: "Wait for approval",
        status: "pending",
        blocker: { kind: "approval", approvalId: approval.id },
      }],
      createdAt: "2026-09-03T22:10:00.000Z",
      updatedAt: "2026-09-03T22:10:00.000Z",
    }]
    const store = new SqliteWorkspaceStore(":memory:", recovered)
    let statusCalls = 0
    const remoteCall = vi.fn(async (method: string) => {
      if (method !== "transfer.status") throw new Error(`Unexpected ${method}`)
      statusCalls += 1
      return {
        state: "committed",
        transferId: statusCalls > 1
          ? packaged.manifest.transferId
          : `transfer-${"0".repeat(32)}`,
        workspacePath: `/target/${packaged.manifest.sessionId}`,
        checkpointCommit,
        ownershipGeneration: 2,
      }
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      sessionTransferRetryMs: 10,
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()
    await waitForDaemon(() => expect(store.load().sessions[0]?.state).toBe("ownership-conflict"))
    expect(remoteCall).toHaveBeenCalledTimes(2)

    expect(store.load().sessions[0]).toMatchObject({
      state: "ownership-conflict",
      workspacePath: "/source/session",
      sourceRecovery: {
        transferId: packaged.manifest.transferId,
        decidedBy: { client: "desktop", clientId: "studio-mac" },
      },
      ownershipConflict: {
        kind: "recovery-contradicted",
        transferId: packaged.manifest.transferId,
        otherMachineId: targetMachineId,
        otherGeneration: 2,
        recoveryAction: "keep-target-session",
      },
    })
    expect(store.load().thread.at(-1)).toMatchObject({
      kind: "system",
      body: "Session ownership conflict detected.",
    })
    expect(store.load().approvals).toHaveLength(0)
    expect(store.load().workingPlans[0]?.steps[0]).not.toHaveProperty("blocker")
  })

  it("clears a recovery claim after the target authoritatively reports no ownership", async () => {
    const { staged, packaged } = await stagedTransferFixture()
    const recovered = recoverUnconfirmedSourceTransfer(
      markSourceTransferReconciliationFailure(staged, {
        sessionId: packaged.manifest.sessionId,
        transferId: packaged.manifest.transferId,
        reason: "target-unreachable",
        failedAt: "2026-09-03T22:09:00.000Z",
      }),
      {
        sessionId: packaged.manifest.sessionId,
        transferId: packaged.manifest.transferId,
        client: "desktop",
        clientId: "studio-mac",
        recoveredAt: "2026-09-03T22:10:00.000Z",
      },
    )
    const store = new SqliteWorkspaceStore(":memory:", recovered)
    const remoteCall = vi.fn(async (method: string) => {
      if (method !== "transfer.status") throw new Error(`Unexpected ${method}`)
      return { state: "unknown", transferId: packaged.manifest.transferId }
    })
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await waitForDaemon(() => expect(store.load().sessions[0]?.sourceRecovery).toBeUndefined())
    expect(store.load().thread.at(-1)).toMatchObject({
      kind: "system",
      body: "Target confirmed it does not own this session.",
    })
    expect(store.auditLog.query({ action: "session.source-recovery-cleared" }).entries)
      .toEqual([expect.objectContaining({
        outcome: "succeeded",
        sessionId: packaged.manifest.sessionId,
        target: targetMachineId,
      })])
  })

  it("restores a proven ownership conflict after its snapshot write fails and the daemon restarts", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-conflict-restart-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const { staged, packaged } = await stagedTransferFixture()
    const recovered = recoverUnconfirmedSourceTransfer(
      markSourceTransferReconciliationFailure(staged, {
        sessionId: packaged.manifest.sessionId,
        transferId: packaged.manifest.transferId,
        reason: "target-unreachable",
        failedAt: "2026-09-03T22:09:00.000Z",
      }),
      {
        sessionId: packaged.manifest.sessionId,
        transferId: packaged.manifest.transferId,
        client: "desktop",
        recoveredAt: "2026-09-03T22:10:00.000Z",
      },
    )
    const store = new SqliteWorkspaceStore(databasePath, recovered)
    vi.spyOn(store, "saveAsync").mockRejectedValue(new Error("disk unavailable"))
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      connectToMachine: async () => ({
        call: async () => ({
          state: "committed",
          transferId: packaged.manifest.transferId,
          workspacePath: `/target/${packaged.manifest.sessionId}`,
          checkpointCommit,
          ownershipGeneration: 2,
        }),
        close: () => {},
      }),
      errorSink: () => {},
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()
    const socket = await openClient(daemon)
    const call = rpc(socket)
    await waitForDaemon(async () => {
      const current = workspaceSnapshotSchema.parse((await call("workspace.get", {})).result)
      expect(current.sessions[0]?.state).toBe("ownership-conflict")
    })
    await expect(call("session.send", {
      sessionId: packaged.manifest.sessionId,
      prompt: "Continue here",
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "This session has conflicting owners and is read-only" },
    })
    expect(store.saveAsync).toHaveBeenCalled()
    expect(store.load().sessions[0]?.state).toBe("ownership-conflict")
    socket.close()

    await daemon.stop()
    running.splice(running.indexOf(daemon), 1)
    const reopened = new SqliteWorkspaceStore(databasePath, recovered)
    expect(reopened.load().sessions[0]).toMatchObject({
      state: "ownership-conflict",
      sourceRecovery: { transferId: packaged.manifest.transferId },
      ownershipConflict: {
        transferId: packaged.manifest.transferId,
        otherMachineId: targetMachineId,
        otherGeneration: 2,
      },
    })
    expect(reopened.loadProject(recovered.project!.id)?.sessions[0]).toMatchObject({
      state: "ownership-conflict",
      ownershipConflict: { transferId: packaged.manifest.transferId },
    })
    reopened.close()
  })

  it("restores direct target ownership evidence after its snapshot write fails", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-direct-conflict-restart-"))
    scratchDirectories.push(scratch)
    const databasePath = join(scratch, "state.sqlite")
    const { source } = await transferFixture()
    const session = source.sessions[0]!
    delete session.ownershipGeneration
    const store = new SqliteWorkspaceStore(databasePath, source)
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    const save = store.saveAsync.bind(store)
    vi.spyOn(store, "saveAsync").mockImplementation(async (snapshot) => {
      if (snapshot.sessions[0]?.state === "ownership-conflict") {
        throw new Error("snapshot disk unavailable")
      }
      await save(snapshot)
    })
    let checkpointed = false
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      workspaceService: {
        inspect: async () => ({
          root: source.project!.path,
          name: source.project!.name,
          branch: source.project!.branch,
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => {
          checkpointed = true
          return { commit: checkpointCommit, changedFiles: [] }
        },
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async () => ({
          headCommit: checkpointed ? checkpointCommit : baseCommit,
          digest: `sha256:${"e".repeat(64)}`,
        }),
        readIgnoredArtifactSource: async () => undefined,
        bundleSession: async (_worktreePath, bundlePath) => ({
          path: bundlePath,
          commit: checkpointCommit,
          incremental: false,
        }),
      },
      readTransferBundle: async () => Buffer.from("PACK exact session"),
      connectToMachine: async () => ({
        call: async (method, params) => {
          if (method === "transfer.preflight") {
            return { allowed: true, targetProjectId: "project-target", lineageCommit: baseCommit }
          }
          if (method === "transfer.status") {
            return { state: "unknown", transferId: String(params.transferId) }
          }
          if (method === "transfer.prepare") {
            return {
              state: "refused",
              transferId: String((params.manifest as { transferId: string }).transferId),
              reason: "target-session-newer",
              existingGeneration: 1,
            }
          }
          throw new Error(`Unexpected ${method}`)
        },
        close: () => {},
      }),
      errorSink: () => {},
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openClient(daemon)
    const call = rpc(socket)
    const preview = await call("session.transferPreview", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
    })
    const approved = preview.result as { contractVersion: 1; intentDigest: string }

    await expect(call("session.transfer", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
      contractVersion: approved.contractVersion,
      intentDigest: approved.intentDigest,
    })).resolves.toMatchObject({
      result: {
        outcome: "incomplete",
        state: "ownership-conflict",
        recoveryAction: "keep-target-session",
      },
    })
    expect(store.saveAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessions: [expect.objectContaining({ state: "ownership-conflict" })],
    }))
    socket.close()

    await daemon.stop()
    running.splice(running.indexOf(daemon), 1)
    const reopened = new SqliteWorkspaceStore(databasePath, source)
    expect(reopened.load().sessions[0]).toMatchObject({
      id: session.id,
      state: "ownership-conflict",
      workspacePath: session.workspacePath,
      ownershipGeneration: 0,
      ownershipConflict: {
        kind: "target-session-detected",
        reason: "target-session-newer",
        otherMachineId: targetMachineId,
        otherGeneration: 1,
        recoveryAction: "keep-target-session",
      },
    })
    reopened.close()
  })

  it.each([
    { name: "resumed prepare", status: "unknown" as const, conflictMethod: "transfer.prepare" },
    { name: "retried commit", status: "failed" as const, conflictMethod: "transfer.commit" },
  ])("freezes target ownership discovered by a $name after restart", async ({
    status,
    conflictMethod,
  }) => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-recovery-conflict-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    await stageOutgoingSessionTransferPackage(outgoing, packaged)
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: outgoing,
      connectToMachine: async () => ({
        call: async (method, params) => {
          if (method === "transfer.status") {
            return status === "failed"
              ? {
                  state: "failed",
                  transferId: String(params.transferId),
                  reason: "persistence-failed",
                }
              : { state: "unknown", transferId: String(params.transferId) }
          }
          if (method === conflictMethod) {
            const remoteTransferId = method === "transfer.prepare"
              ? String((params.manifest as { transferId: string }).transferId)
              : String(params.transferId)
            return {
              state: "refused",
              transferId: remoteTransferId,
              reason: "target-session-newer",
              existingGeneration: 2,
            }
          }
          throw new Error(`Unexpected ${method}`)
        },
        close: () => {},
      }),
      sessionTransferRetryMs: 10,
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()
    await waitForDaemon(() => expect(store.load().sessions[0]?.state).toBe("ownership-conflict"))
    expect(store.load().sessions[0]).toMatchObject({
      workspacePath: "/source/session",
      ownershipGeneration: 1,
      ownershipConflict: {
        kind: "target-session-detected",
        reason: "target-session-newer",
        otherMachineId: targetMachineId,
        otherGeneration: 2,
        recoveryAction: "keep-target-session",
      },
    })
  })

  it("reconciles an ambiguous live transfer after returning the incomplete result", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-live-reconcile-"))
    scratchDirectories.push(scratch)
    const { source } = await transferFixture()
    const store = new SqliteWorkspaceStore(":memory:", source)
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    let checkpointed = false
    let statusCalls = 0
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      workspaceService: {
        inspect: async () => ({
          root: source.project!.path,
          name: source.project!.name,
          branch: source.project!.branch,
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => {
          checkpointed = true
          return { commit: checkpointCommit, changedFiles: [] }
        },
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async () => ({
          headCommit: checkpointed ? checkpointCommit : baseCommit,
          digest: `sha256:${"e".repeat(64)}`,
        }),
        readIgnoredArtifactSource: async () => undefined,
        bundleSession: async (_worktreePath, bundlePath) => ({
          path: bundlePath,
          commit: checkpointCommit,
          incremental: false,
        }),
      },
      readTransferBundle: async () => Buffer.from("PACK exact session"),
      connectToMachine: async () => ({
        call: async (method, params) => {
          if (method === "transfer.preflight") {
            return { allowed: true, targetProjectId: "project-target", lineageCommit: baseCommit }
          }
          if (method === "transfer.status") {
            statusCalls += 1
            if (statusCalls === 1) throw new Error("target reply was lost")
            return {
              state: "committed",
              transferId: String(params.transferId),
              workspacePath: `/target/${source.sessions[0]!.id}`,
              checkpointCommit,
              ownershipGeneration: 2,
            }
          }
          throw new Error(`Unexpected ${method}`)
        },
        close: () => {},
      }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openClient(daemon)
    const call = rpc(socket)
    const preview = await call("session.transferPreview", {
      sessionId: source.sessions[0]!.id,
      targetMachineId,
      initiatedByClient: "desktop",
    })
    const approved = preview.result as { contractVersion: 1; intentDigest: string }

    await expect(call("session.transfer", {
      sessionId: source.sessions[0]!.id,
      targetMachineId,
      initiatedByClient: "desktop",
      contractVersion: approved.contractVersion,
      intentDigest: approved.intentDigest,
    })).resolves.toMatchObject({
      result: {
        outcome: "incomplete",
        state: "unknown",
        recoveryAction: "none",
      },
    })
    await waitForDaemon(() => expect(store.load().sessions[0]?.state).toBe("transferred"))
    expect(statusCalls).toBe(2)
    socket.close()
  })

  it("removes imported package bytes after canonical ownership commits", async () => {
    const { call, commitParams, packaged, socket, transactions } =
      await preparedTargetTransfer()
    const remove = vi.spyOn(transactions, "remove")

    await expect(call("transfer.commit", commitParams)).resolves.toMatchObject({
      result: {
        state: "committed",
        checkpointCommit,
        ownershipGeneration: 2,
      },
    })

    expect(remove).toHaveBeenCalledWith(
      packaged.manifest.transferId,
      packaged.manifestDigest,
    )
    await expect(transactions.status(
      packaged.manifest.transferId,
      packaged.manifestDigest,
    )).resolves.toMatchObject({ state: "unknown" })
    await expect(call("transfer.status", commitParams)).resolves.toMatchObject({
      result: {
        state: "committed",
        checkpointCommit,
        ownershipGeneration: 2,
      },
    })
    socket.close()
  })

  it("keeps an imported owner authoritative when the transaction journal commit fails", async () => {
    const { call, commitParams, daemon, packaged, socket, store, transactions } =
      await preparedTargetTransfer()
    vi.spyOn(transactions, "markCommitted")
      .mockRejectedValueOnce(new Error("journal unavailable after snapshot commit"))
    await expect(call("transfer.commit", commitParams)).resolves.toMatchObject({
      error: { code: -32603 },
    })

    const importedAfterJournalFailure = workspaceSnapshotSchema.parse(store.load())
    expect(importedAfterJournalFailure.sessions).toEqual([
      expect.objectContaining({
        id: packaged.manifest.sessionId,
        ownershipGeneration: 2,
        transferredFrom: expect.objectContaining({ transferId: packaged.manifest.transferId }),
      }),
    ])
    await expect(call("transfer.commit", commitParams)).resolves.toMatchObject({
      result: {
        state: "committed",
        checkpointCommit,
        ownershipGeneration: 2,
      },
    })
    await expect(transactions.status(
      packaged.manifest.transferId,
      packaged.manifestDigest,
    )).resolves.toMatchObject({ state: "unknown" })
    await expect(call("transfer.status", commitParams)).resolves.toMatchObject({
      result: { state: "committed" },
    })
    const imported = workspaceSnapshotSchema.parse(store.load())
    expect(imported.sessions).toHaveLength(1)
    expect(imported.sessions[0]).toMatchObject({
      id: packaged.manifest.sessionId,
      state: "idle",
      ownershipGeneration: 2,
      runtime: { auto: false },
      transferredFrom: {
        transferId: packaged.manifest.transferId,
        sourceMachineId,
        checkpointCommit,
      },
    })
    expect(imported.thread.filter((item) => item.id.startsWith("system-transfer-")))
      .toHaveLength(1)

    const clientSocket = await openClient(daemon)
    const clientCall = rpc(clientSocket)
    const confirmation = await clientCall("project.open", {
      path: "/target/other",
      client: "desktop",
    })
    await expect(clientCall("project.open", {
      path: "/target/other",
      client: "desktop",
      confirmation: (confirmation.error as { data: unknown }).data,
    })).resolves.toMatchObject({ result: { project: { path: "/target/other" }, sessions: [] } })
    await expect(call("transfer.status", commitParams)).resolves.toMatchObject({
      result: {
        state: "committed",
        checkpointCommit,
        ownershipGeneration: 2,
      },
    })
    await expect(call("transfer.prepare", {
      manifest: packaged.manifest,
      manifestDigest: packaged.manifestDigest,
      initiatedByClient: "desktop",
    })).resolves.toMatchObject({ result: { state: "committed" } })
    await expect(call("transfer.abort", commitParams)).resolves.toMatchObject({
      result: { state: "committed" },
    })

    const loaded = workspaceSnapshotSchema.parse(store.load())
    expect(loaded.sessions).toHaveLength(0)
    clientSocket.close()
    socket.close()
  })

  it("refuses an unsupported target transport before accepting transfer bytes", async () => {
    const snapshot = targetSnapshot()
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-unsupported-transfer-"))
    scratchDirectories.push(scratch)
    const transactions = new FileTransferTransactions(join(scratch, "transactions"))
    const store = new SqliteWorkspaceStore(":memory:", snapshot)
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      transferTransactions: transactions,
      workspaceService: {
        inspect: async () => ({
          root: "/target/project",
          name: "project",
          branch: "main",
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => ({ commit: checkpointCommit, changedFiles: [] }),
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        projectHasLineage: async () => true,
      },
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const { socket } = await openMachine(daemon, store)
    const call = rpc(socket)
    const packaged = await packagedTransfer()
    const preflight = {
      contractVersion: packaged.manifest.version,
      sessionId: packaged.manifest.sessionId,
      sourceMachineId,
      sourceProjectId: packaged.manifest.project.sourceProjectId,
      lineageCommit: baseCommit,
      ownershipGeneration: packaged.manifest.ownership.fromGeneration,
      method: packaged.manifest.repository.method,
      coverage: packaged.manifest.coverage,
      initiatedByClient: "desktop",
    }

    await expect(call("transfer.preflight", preflight)).resolves.toMatchObject({
      result: { allowed: false, reason: "target-bundle-restore-unavailable" },
    })
    await expect(call("transfer.prepare", {
      manifest: packaged.manifest,
      manifestDigest: packaged.manifestDigest,
      initiatedByClient: "desktop",
    })).resolves.toMatchObject({
      result: {
        state: "refused",
        transferId: packaged.manifest.transferId,
        reason: "target-bundle-restore-unavailable",
      },
    })
    await expect(transactions.status(
      packaged.manifest.transferId,
      packaged.manifestDigest,
    )).resolves.toEqual({ state: "unknown", transferId: packaged.manifest.transferId })
    socket.close()
  })

  it("previews the exact portable contract without freezing the source", async () => {
    const source = structuredClone(demoWorkspace)
    source.machine.id = sourceMachineId
    source.project = {
      ...source.project!,
      machineId: sourceMachineId,
      path: "/source/project",
    }
    const session = source.sessions.find((candidate) => candidate.state === "idle")!
    session.workspacePath = "/source/session"
    session.baseCommit = baseCommit
    session.ownershipGeneration = 3
    source.sessions = [session]
    source.activeSessionId = session.id
    source.thread = source.thread.filter((item) => item.sessionId === session.id)
    source.artifacts = []
    source.workingPlans = []
    source.annotations = []
    source.approvals = []
    const store = new SqliteWorkspaceStore(":memory:", source)
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    const remoteCalls: Array<{ method: string, params: Record<string, unknown> }> = []
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      workspaceService: {
        inspect: async () => ({
          root: "/source/project",
          name: "source",
          branch: "main",
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({
          path: "/unused",
          branch: "unused",
          baseCommit,
        }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => ({ commit: checkpointCommit, changedFiles: [] }),
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async () => ({
          headCommit: baseCommit,
          digest: `sha256:${"e".repeat(64)}`,
        }),
        readIgnoredArtifactSource: async () => undefined,
        bundleSession: async (_worktreePath, bundlePath) => ({
          path: bundlePath,
          commit: checkpointCommit,
          incremental: false,
        }),
      },
      connectToMachine: async () => ({
        call: async (method, params) => {
          remoteCalls.push({ method, params })
          return { allowed: true, targetProjectId: "project-target", lineageCommit: baseCommit }
        },
        close: () => {},
      }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openClient(daemon)
    const call = rpc(socket)

    const previewResponse = await call("session.transferPreview", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
    })
    expect(previewResponse).toMatchObject({
      result: {
        allowed: true,
        sessionId: session.id,
        sourceMachineId,
        targetMachineId,
        project: { targetProjectId: "project-target", lineageCommit: baseCommit },
        coverage: {
          included: expect.arrayContaining([
            { kind: "repository", count: 1 },
            { kind: "thread", count: source.thread.length },
          ]),
        },
      },
    })
    const preview = previewResponse.result as {
      contractVersion: 1
      coverage: SessionTransferCoverage
    }
    expect(remoteCalls).toEqual([{
      method: "transfer.preflight",
      params: {
        contractVersion: preview.contractVersion,
        sessionId: session.id,
        sourceMachineId,
        sourceProjectId: source.project.id,
        lineageCommit: baseCommit,
        ownershipGeneration: 3,
        method: "git-bundle",
        coverage: preview.coverage,
        initiatedByClient: "desktop",
      },
    }])
    remoteCalls.length = 0
    await expect(call("session.transfer", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Method parameters are invalid" },
    })
    expect(remoteCalls).toEqual([])
    expect((store.load().sessions[0])?.state).toBe("idle")
    socket.close()
  })

  it.each([
    ["bundle creation", "git-bundle", undefined, "source-bundle-create-unavailable", false],
    ["ref publishing", "remote-ref", "origin", "source-ref-push-unavailable", false],
  ] as const)(
    "refuses preview before target contact when source %s is unavailable",
    async (_label, method, remote, reason, canCreateBundle) => {
      const { source } = await transferFixture()
      const store = new SqliteWorkspaceStore(":memory:", source)
      store.fleet.record({
        id: targetMachineId,
        label: "studio",
        platform: "linux",
        arch: "x64",
        version: "0.0.1",
        connection: "local",
        capabilities: ["sessions"],
        protocolVersion,
        transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
      }, Date.now())
      const connectToMachine = vi.fn(async () => ({
        call: async () => ({
          allowed: true,
          targetProjectId: "project-target",
          lineageCommit: baseCommit,
        }),
        close: () => {},
      }))
      const daemon = new DomovoiDaemon({
        port: 0,
        store,
        authToken: testAuthToken("correct-horse-battery-staple"),
        workspaceService: {
          inspect: async () => ({
            root: source.project!.path,
            name: source.project!.name,
            branch: source.project!.branch,
            head: baseCommit,
          }),
          createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
          removeSessionWorkspace: async () => {},
          checkpoint: async () => ({ commit: checkpointCommit, changedFiles: [] }),
          restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
          transferFingerprint: async () => ({
            headCommit: baseCommit,
            digest: `sha256:${"e".repeat(64)}`,
          }),
          readIgnoredArtifactSource: async () => undefined,
          ...(canCreateBundle ? {
            bundleSession: async (_worktreePath: string, bundlePath: string) => ({
              path: bundlePath,
              commit: checkpointCommit,
              incremental: false,
            }),
          } : {}),
        },
        connectToMachine,
        artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
      })
      running.push(daemon)
      await daemon.start()
      const socket = await openClient(daemon)
      await expect(rpc(socket)("session.transferPreview", {
        sessionId: source.sessions[0]!.id,
        targetMachineId,
        method,
        ...(remote ? { remote } : {}),
        initiatedByClient: "desktop",
      })).resolves.toMatchObject({ result: { allowed: false, reason } })
      expect(connectToMachine).not.toHaveBeenCalled()
      socket.close()
    },
  )

  it("tells a client to pair again when the target rejects its machine credential", async () => {
    const { source } = await transferFixture()
    const store = new SqliteWorkspaceStore(":memory:", source)
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion: source.protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      workspaceService: {
        inspect: async () => ({
          root: source.project!.path,
          name: source.project!.name,
          branch: source.project!.branch,
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => ({ commit: checkpointCommit, changedFiles: [] }),
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async () => ({
          headCommit: baseCommit,
          digest: `sha256:${"e".repeat(64)}`,
        }),
        readIgnoredArtifactSource: async () => undefined,
        bundleSession: async (_worktreePath, bundlePath) => ({
          path: bundlePath,
          commit: checkpointCommit,
          incremental: false,
        }),
      },
      connectToMachine: async () => { throw new MachinePairingRequiredError() },
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openClient(daemon)

    await expect(rpc(socket)("session.transferPreview", {
      sessionId: source.sessions[0]!.id,
      targetMachineId,
      initiatedByClient: "desktop",
    })).resolves.toMatchObject({
      result: { allowed: false, reason: "target-pairing-required" },
    })
    socket.close()
  })

  it("thaws the source when terminal shutdown fails before target delivery", async () => {
    const { source } = await transferFixture()
    const session = source.sessions[0]!
    const store = new SqliteWorkspaceStore(":memory:", source)
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    const checkpoint = vi.fn(async () => ({ commit: checkpointCommit, changedFiles: [] }))
    const terminal = {
      process: "bash",
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => { throw new Error("terminal kill failed") }),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      terminalService: { spawn: vi.fn(() => terminal) },
      workspaceService: {
        inspect: async () => ({
          root: source.project!.path,
          name: source.project!.name,
          branch: source.project!.branch,
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint,
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async () => ({
          headCommit: baseCommit,
          digest: `sha256:${"e".repeat(64)}`,
        }),
        readIgnoredArtifactSource: async () => undefined,
        bundleSession: async (_worktreePath, bundlePath) => ({
          path: bundlePath,
          commit: checkpointCommit,
          incremental: false,
        }),
      },
      connectToMachine: async () => ({
        call: async (method) => {
          if (method === "transfer.preflight") {
            return { allowed: true, targetProjectId: "project-target", lineageCommit: baseCommit }
          }
          throw new Error(`Unexpected ${method}`)
        },
        close: () => {},
      }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openClient(daemon, "studio-mac")
    const call = rpc(socket)
    await expect(call("terminal.create", {
      terminalId: "terminal-transfer-shutdown",
      sessionId: session.id,
      cols: 80,
      rows: 24,
      client: "desktop",
      clientId: "studio-mac",
    })).resolves.toHaveProperty("result")
    const preview = await call("session.transferPreview", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
    })
    const approved = preview.result as { contractVersion: 1; intentDigest: string }

    await expect(call("session.transfer", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
      contractVersion: approved.contractVersion,
      intentDigest: approved.intentDigest,
    })).resolves.toMatchObject({
      result: { outcome: "refused", reason: "session-resource-unavailable" },
    })
    expect(terminal.kill).toHaveBeenCalledOnce()
    expect(checkpoint).not.toHaveBeenCalled()
    expect(store.load().sessions[0]).toMatchObject({
      id: session.id,
      state: "idle",
      baseCommit,
    })
    socket.close()
  })

  it.each([
    { failure: "package read", failCheckpointPersistence: false },
    { failure: "checkpoint snapshot persistence", failCheckpointPersistence: true },
  ])("retains the checkpoint base when $failure fails before target delivery", async ({
    failCheckpointPersistence,
  }) => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-package-failure-"))
    scratchDirectories.push(scratch)
    const { source } = await transferFixture()
    const session = source.sessions[0]!
    const store = new SqliteWorkspaceStore(":memory:", source)
    if (failCheckpointPersistence) {
      const save = store.saveAsync.bind(store)
      let saveCount = 0
      vi.spyOn(store, "saveAsync").mockImplementation(async (snapshot) => {
        saveCount += 1
        if (saveCount === 2) throw new Error("checkpoint snapshot write failed")
        await save(snapshot)
      })
    }
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    let checkpointed = false
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      workspaceService: {
        inspect: async () => ({
          root: source.project!.path,
          name: source.project!.name,
          branch: source.project!.branch,
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => {
          checkpointed = true
          return { commit: checkpointCommit, changedFiles: [] }
        },
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async () => ({
          headCommit: checkpointed ? checkpointCommit : baseCommit,
          digest: `sha256:${"e".repeat(64)}`,
        }),
        readIgnoredArtifactSource: async () => undefined,
        bundleSession: async (_worktreePath, bundlePath) => ({
          path: bundlePath,
          commit: checkpointCommit,
          incremental: false,
        }),
      },
      readTransferBundle: async () => { throw new Error("bundle read failed") },
      connectToMachine: async () => ({
        call: async (method) => {
          if (method === "transfer.preflight") {
            return { allowed: true, targetProjectId: "project-target", lineageCommit: baseCommit }
          }
          throw new Error(`Unexpected ${method}`)
        },
        close: () => {},
      }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openClient(daemon)
    const call = rpc(socket)
    const preview = await call("session.transferPreview", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
    })
    const approved = preview.result as { contractVersion: 1; intentDigest: string }

    await expect(call("session.transfer", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
      contractVersion: approved.contractVersion,
      intentDigest: approved.intentDigest,
    })).resolves.toMatchObject({
      result: { outcome: "refused", reason: "session-resource-unavailable" },
    })
    expect(store.load().sessions[0]).toMatchObject({
      id: session.id,
      state: "idle",
      baseCommit: checkpointCommit,
    })
    socket.close()
  })

  it("freezes and stages the source before committing one target owner", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-source-rpc-"))
    scratchDirectories.push(scratch)
    const source = structuredClone(demoWorkspace)
    source.machine.id = sourceMachineId
    source.project = {
      ...source.project!,
      machineId: sourceMachineId,
      path: "/source/project",
    }
    const session = source.sessions.find((candidate) => candidate.state === "idle")!
    session.workspacePath = "/source/session"
    session.baseCommit = baseCommit
    session.ownershipGeneration = 3
    session.runtime = {
      provider: "claude-code",
      model: "claude-opus-5",
      reasoning: "high",
      permissionMode: "build",
      auto: true,
    }
    delete session.providerThreadId
    source.sessions = [session]
    source.activeSessionId = session.id
    source.thread = source.thread.filter((item) => item.sessionId === session.id)
    source.artifacts = []
    source.workingPlans = []
    source.annotations = []
    source.approvals = []
    const store = new SqliteWorkspaceStore(":memory:", source)
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    const targetTransactions = new FileTransferTransactions(join(scratch, "target"))
    let checkpointed = false
    let observedStagedSource = false
    const bundleSession = vi.fn(async (_worktreePath: string, bundlePath: string) => ({
      path: bundlePath,
      commit: checkpointCommit,
      incremental: false,
    }))
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: outgoing,
      workspaceService: {
        inspect: async () => ({
          root: "/source/project",
          name: "source",
          branch: "main",
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({
          path: "/unused",
          branch: "unused",
          baseCommit,
        }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => {
          checkpointed = true
          return { commit: checkpointCommit, changedFiles: [] }
        },
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async () => {
          return {
            headCommit: checkpointed ? checkpointCommit : baseCommit,
            digest: `sha256:${"e".repeat(64)}`,
          }
        },
        readIgnoredArtifactSource: async () => undefined,
        bundleSession,
      },
      readTransferBundle: async () => Buffer.from("PACK exact session"),
      connectToMachine: async () => ({
        call: async (method, params) => {
          if (method === "transfer.preflight") {
            return { allowed: true, targetProjectId: "project-target", lineageCommit: baseCommit }
          }
          if (method === "transfer.status") {
            const frozen = store.load().sessions[0]!
            observedStagedSource = frozen.state === "transferring"
              && frozen.transfer?.phase === "transferring"
              && frozen.transfer.package.state === "staged"
            return targetTransactions.status(String(params.transferId), String(params.manifestDigest))
          }
          if (method === "transfer.prepare") {
            return targetTransactions.prepare(
              params.manifest as never,
              String(params.manifestDigest),
            )
          }
          if (method === "transfer.member") return targetTransactions.acceptMember(params as never)
          if (method === "transfer.commit") {
            const manifest = await targetTransactions.manifest(
              String(params.transferId),
              String(params.manifestDigest),
            )
            return {
              state: "committed",
              transferId: manifest.transferId,
              workspacePath: `/target/${manifest.sessionId}`,
              checkpointCommit: manifest.project.checkpointCommit,
              ownershipGeneration: manifest.ownership.toGeneration,
            }
          }
          throw new Error(`Unexpected ${method}`)
        },
        close: () => {},
      }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openClient(daemon)
    const call = rpc(socket)
    const preview = await call("session.transferPreview", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
    })
    const approved = preview.result as { contractVersion: 1, intentDigest: string }

    const moved = await call("session.transfer", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
      contractVersion: approved.contractVersion,
      intentDigest: approved.intentDigest,
    })
    expect(moved.result).toMatchObject({
      outcome: "succeeded",
      contractVersion: 1,
      ownershipGeneration: 4,
    })
    expect(bundleSession).toHaveBeenCalledWith(
      session.workspacePath,
      expect.any(String),
      undefined,
      expect.any(AbortSignal),
      [
        ...source.thread.flatMap((item) => (
          item.kind === "checkpoint" && item.commit ? [item.commit] : []
        )),
        checkpointCommit,
      ],
    )
    expect(observedStagedSource).toBe(true)
    expect(store.load().sessions[0]).toMatchObject({
      state: "transferred",
      ownershipGeneration: 4,
      runtime: { auto: false },
      transfer: { phase: "transferred" },
    })
    const transferred = store.load().sessions[0]!
    if (transferred.transfer?.phase !== "transferred") {
      throw new Error("Expected transferred source")
    }
    await expect(outgoing.status(
      transferred.transfer.transferId,
      transferred.transfer.manifestDigest,
    )).resolves.toMatchObject({ state: "unknown" })
    await expect(call("session.send", {
      sessionId: session.id,
      prompt: "keep working",
      client: "desktop",
    })).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "This session belongs to another machine and is read-only here",
      },
    })
    await expect(call("session.archive", {
      sessionId: session.id,
      client: "desktop",
    })).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "This session belongs to another machine and is read-only here",
      },
    })
    socket.close()
  })

  it.each(["prepare", "commit"] as const)(
    "freezes direct target ownership evidence from transfer.%s until explicitly released",
    async (conflictAt) => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-direct-conflict-"))
    scratchDirectories.push(scratch)
    const { source } = await transferFixture()
    const session = source.sessions[0]!
    const store = new SqliteWorkspaceStore(":memory:", source)
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    let checkpointed = false
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      workspaceService: {
        inspect: async () => ({
          root: source.project!.path,
          name: source.project!.name,
          branch: source.project!.branch,
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint: async () => {
          checkpointed = true
          return { commit: checkpointCommit, changedFiles: [] }
        },
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async () => ({
          headCommit: checkpointed ? checkpointCommit : baseCommit,
          digest: `sha256:${"e".repeat(64)}`,
        }),
        readIgnoredArtifactSource: async () => undefined,
        bundleSession: async (_worktreePath, bundlePath) => ({
          path: bundlePath,
          commit: checkpointCommit,
          incremental: false,
        }),
      },
      readTransferBundle: async () => Buffer.from("PACK exact session"),
      connectToMachine: async () => ({
        call: async (method, params) => {
          if (method === "transfer.preflight") {
            return { allowed: true, targetProjectId: "project-target", lineageCommit: baseCommit }
          }
          if (method === "transfer.status") {
            return { state: "unknown", transferId: String(params.transferId) }
          }
          if (method === "transfer.prepare") {
            const remoteTransferId = String((params.manifest as { transferId: string }).transferId)
            return conflictAt === "prepare"
              ? {
                  state: "refused",
                  transferId: remoteTransferId,
                  reason: "target-session-newer",
                  existingGeneration: 2,
                }
              : { state: "prepared", transferId: remoteTransferId }
          }
          if (method === "transfer.commit" && conflictAt === "commit") {
            return {
              state: "refused",
              transferId: String(params.transferId),
              reason: "target-session-newer",
              existingGeneration: 2,
            }
          }
          throw new Error(`Unexpected ${method}`)
        },
        close: () => {},
      }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openClient(daemon, "studio-mac")
    const call = rpc(socket)
    const preview = await call("session.transferPreview", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
    })
    const approved = preview.result as { contractVersion: 1; intentDigest: string }

    const conflict = await call("session.transfer", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
      contractVersion: approved.contractVersion,
      intentDigest: approved.intentDigest,
    })
    expect(conflict.result).toMatchObject({
      outcome: "incomplete",
      state: "ownership-conflict",
      recoveryAction: "keep-target-session",
    })
    const frozen = store.load().sessions[0]!
    expect(frozen).toMatchObject({
      state: "ownership-conflict",
      workspacePath: session.workspacePath,
      ownershipGeneration: 1,
      ownershipConflict: {
        kind: "target-session-detected",
        reason: "target-session-newer",
        otherMachineId: targetMachineId,
        otherGeneration: 2,
      },
    })

    await expect(call("session.transferResolveConflict", {
      sessionId: session.id,
      transferId: frozen.ownershipConflict!.transferId,
      confirmation: "keep-target-session",
      initiatedByClient: "desktop",
    })).resolves.toMatchObject({
      result: {
        sessions: [expect.objectContaining({
          id: session.id,
          state: "transferred",
          workspacePath: session.workspacePath,
          ownershipGeneration: 2,
          transfer: expect.objectContaining({
            completion: "conflict-released",
            targetMachineId,
          }),
        })],
      },
    })
    expect(store.load().thread.at(-1)).toMatchObject({
      body: "Source ownership released to the target session.",
      detail: expect.stringContaining("studio-mac"),
    })
    socket.close()
    },
  )

  it("never loses one source freeze when two sessions move concurrently", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-concurrent-source-"))
    scratchDirectories.push(scratch)
    const source = structuredClone(demoWorkspace)
    source.machine.id = sourceMachineId
    source.project = {
      ...source.project!,
      machineId: sourceMachineId,
      path: "/source/project",
    }
    const sessions = source.sessions.slice(0, 2)
    for (const [index, session] of sessions.entries()) {
      session.state = "idle"
      session.workspacePath = `/source/session-${index}`
      session.baseCommit = baseCommit
      session.ownershipGeneration = 1
      session.runtime.auto = false
      delete session.activeTurnId
      delete session.providerThreadId
    }
    source.sessions = sessions
    source.activeSessionId = sessions[0]!.id
    const sessionIds = new Set(sessions.map(({ id }) => id))
    source.thread = source.thread.filter((item) => sessionIds.has(item.sessionId))
    source.artifacts = source.artifacts.filter((artifact) => sessionIds.has(artifact.sessionId))
    source.workingPlans = source.workingPlans.filter((plan) => sessionIds.has(plan.sessionId))
    source.annotations = source.annotations.filter((annotation) => sessionIds.has(annotation.sessionId))
    source.approvals = []
    const store = new SqliteWorkspaceStore(":memory:", source)
    store.fleet.record({
      id: targetMachineId,
      label: "studio",
      platform: "linux",
      arch: "x64",
      version: "0.0.1",
      connection: "local",
      capabilities: ["sessions"],
      protocolVersion,
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    const originalSave = store.saveAsync.bind(store)
    let releaseFirstFreeze = () => {}
    let signalFirstFreeze = () => {}
    const firstFreeze = new Promise<void>((resolve) => { signalFirstFreeze = resolve })
    let signalSecondFreezePersisted = () => {}
    const secondFreezePersisted = new Promise<void>((resolve) => {
      signalSecondFreezePersisted = resolve
    })
    let saveCount = 0
    vi.spyOn(store, "saveAsync").mockImplementation(async (snapshot) => {
      const callNumber = ++saveCount
      if (callNumber === 1) {
        signalFirstFreeze()
        await new Promise<void>((resolve) => {
          releaseFirstFreeze = resolve
        })
      }
      await originalSave(snapshot)
      if (callNumber === 2) signalSecondFreezePersisted()
    })
    const checkpointed = new Set<string>()
    const targetTransactions = new FileTransferTransactions(join(scratch, "target"))
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: testAuthToken("correct-horse-battery-staple"),
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      workspaceService: {
        inspect: async () => ({
          root: "/source/project",
          name: "source",
          branch: "main",
          head: baseCommit,
        }),
        createSessionWorkspace: async () => ({ path: "/unused", branch: "unused", baseCommit }),
        removeSessionWorkspace: async () => {},
        checkpoint: async (path) => {
          checkpointed.add(path)
          return { commit: checkpointCommit, changedFiles: [] }
        },
        restore: async () => ({ restoredCommit: checkpointCommit, recoveryCommit: checkpointCommit }),
        transferFingerprint: async (path) => ({
          headCommit: checkpointed.has(path) ? checkpointCommit : baseCommit,
          digest: `sha256:${"e".repeat(64)}`,
        }),
        readIgnoredArtifactSource: async () => undefined,
        bundleSession: async (_worktreePath, bundlePath) => ({
          path: bundlePath,
          commit: checkpointCommit,
          incremental: false,
        }),
      },
      readTransferBundle: async () => Buffer.from("PACK exact session"),
      connectToMachine: async () => ({
        call: async (method, params) => {
          if (method === "transfer.preflight") {
            return { allowed: true, targetProjectId: "project-target", lineageCommit: baseCommit }
          }
          if (method === "transfer.status") {
            return targetTransactions.status(String(params.transferId), String(params.manifestDigest))
          }
          if (method === "transfer.prepare") {
            return targetTransactions.prepare(params.manifest as never, String(params.manifestDigest))
          }
          if (method === "transfer.member") return targetTransactions.acceptMember(params as never)
          if (method === "transfer.commit") {
            const manifest = await targetTransactions.manifest(
              String(params.transferId),
              String(params.manifestDigest),
            )
            return {
              state: "committed",
              transferId: manifest.transferId,
              workspacePath: `/target/${manifest.sessionId}`,
              checkpointCommit: manifest.project.checkpointCommit,
              ownershipGeneration: manifest.ownership.toGeneration,
            }
          }
          throw new Error(`Unexpected ${method}`)
        },
        close: () => {},
      }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openClient(daemon)
    const call = rpc(socket)
    const approved = new Map<string, { contractVersion: 1; intentDigest: string }>()
    for (const session of sessions) {
      const response = await call("session.transferPreview", {
        sessionId: session.id,
        targetMachineId,
        initiatedByClient: "desktop",
      })
      expect(response.result).toMatchObject({
        allowed: true,
        contractVersion: 1,
        intentDigest: expect.any(String),
      })
      approved.set(session.id, response.result as { contractVersion: 1; intentDigest: string })
    }

    const moves = sessions.map((session) => call("session.transfer", {
      sessionId: session.id,
      targetMachineId,
      initiatedByClient: "desktop",
      contractVersion: approved.get(session.id)!.contractVersion,
      intentDigest: approved.get(session.id)!.intentDigest,
    }))
    await firstFreeze
    // The old implementation can persist the second whole-snapshot candidate
    // while the first is blocked, then overwrite it when the first resumes.
    // The serialized slice implementation intentionally makes this race lose
    // the timeout before releasing the first save.
    await Promise.race([
      secondFreezePersisted,
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ])
    releaseFirstFreeze()
    await expect(moves[1]).resolves.toMatchObject({ result: { outcome: "succeeded" } })
    await expect(moves[0]).resolves.toMatchObject({ result: { outcome: "succeeded" } })

    expect(store.load().sessions).toEqual(expect.arrayContaining(sessions.map((session) => (
      expect.objectContaining({
        id: session.id,
        state: "transferred",
        ownershipGeneration: 2,
      })
    ))))
    socket.close()
  })
})
