import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"

import {
  demoWorkspace,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from "@getdomovoi/protocol"

import { DomovoiDaemon } from "./server.js"
import {
  createSessionTransferPackage,
  prepareSessionTransferIntent,
} from "./session-transfer-package.js"
import {
  freezeSourceSessionTransfer,
  recoverUnconfirmedSourceTransfer,
  stageOutgoingSessionTransferPackage,
  stageSourceSessionCheckpoint,
} from "./session-transfer-source.js"
import { SqliteWorkspaceStore } from "./store.js"
import { FileTransferTransactions } from "./transfer-transactions.js"
import type { WorkspaceService } from "./workspace.js"

const running: DomovoiDaemon[] = []
const scratchDirectories: string[] = []
const sourceMachineId = `machine-${"a".repeat(32)}`
const targetMachineId = `machine-${"b".repeat(32)}`
const baseCommit = "c".repeat(40)
const checkpointCommit = "d".repeat(40)

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
  machineId = sourceMachineId,
): Promise<WebSocket> {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, {
    headers: { authorization: `Bearer ${daemon.authToken}` },
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  const call = rpc(socket)
  await call("system.hello", {
    client: "machine",
    machineId,
    clientVersion: "0.0.1",
    protocolVersion: "0.1.0",
  })
  return socket
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
    protocolVersion: "0.1.0",
  })
  return socket
}

describe("transactional session transfer RPC", () => {
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
      protocolVersion: "0.1.0",
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
      authToken: "correct-horse-battery-staple",
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
      client: "desktop",
    }

    const machineSocket = await openMachine(daemon, targetMachineId)
    await expect(rpc(machineSocket)("session.transferPreview", request)).resolves.toMatchObject({
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
    await expect(rpc(machineSocket)("session.transfer", transfer)).resolves.toMatchObject({
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
      authToken: "correct-horse-battery-staple",
      transferTransactions: incoming,
      outgoingTransferTransactions: outgoing,
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    expect(pruneIncoming).toHaveBeenCalledOnce()
    expect(pruneOutgoing).toHaveBeenCalledOnce()
  })

  it("finishes a committed staged transfer after the source restarts", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-restart-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const store = new SqliteWorkspaceStore(":memory:", staged)
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    await stageOutgoingSessionTransferPackage(outgoing, packaged)
    const remoteCall = vi.fn(async (method: string) => {
      if (method !== "transfer.status") throw new Error(`Unexpected ${method}`)
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
      authToken: "correct-horse-battery-staple",
      outgoingTransferTransactions: outgoing,
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await vi.waitFor(() => expect(store.load().sessions[0]?.state).toBe("transferred"))
    expect(remoteCall).toHaveBeenCalledOnce()
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
    await expect(outgoing.status(
      packaged.manifest.transferId,
      packaged.manifestDigest,
    )).resolves.toMatchObject({ state: "unknown" })
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
      authToken: "correct-horse-battery-staple",
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await vi.waitFor(() => expect(store.load().sessions[0]?.state).toBe("idle"))
    expect(remoteCall).toHaveBeenCalledOnce()
    expect(store.load().sessions[0]).toMatchObject({
      state: "idle",
      ownershipGeneration: 1,
      runtime: { auto: false },
    })
    expect(store.load().sessions[0]).not.toHaveProperty("transfer")
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
      authToken: "correct-horse-battery-staple",
      outgoingTransferTransactions: outgoing,
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await vi.waitFor(() => expect(store.load().sessions[0]?.state).toBe("transferred"))
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
      authToken: "correct-horse-battery-staple",
      outgoingTransferTransactions: outgoing,
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await vi.waitFor(() => expect(store.load().sessions[0]?.state).toBe("idle"))
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
      authToken: "correct-horse-battery-staple",
      outgoingTransferTransactions: new FileTransferTransactions(join(scratch, "outgoing")),
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()

    await vi.waitFor(() => expect(store.load().sessions[0]?.state).toBe("transferred"))
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
      authToken: "correct-horse-battery-staple",
      outgoingTransferTransactions: outgoing,
      connectToMachine,
      errorSink: () => {},
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    await vi.waitFor(() => expect(connectToMachine).toHaveBeenCalledOnce())
    expect(store.load().sessions[0]?.state).toBe("transferring")
    const socket = await openClient(daemon, "studio-mac")

    const recovered = await rpc(socket)("session.transferRecoverSource", {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      confirmation: "target-does-not-have-session",
      client: "desktop",
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

  it("freezes the claimant when a recovered target later proves it owns the session", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-owner-conflict-"))
    scratchDirectories.push(scratch)
    const { staged, packaged } = await stagedTransferFixture()
    const recovered = recoverUnconfirmedSourceTransfer(staged, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      client: "desktop",
      clientId: "studio-mac",
      recoveredAt: "2026-09-03T22:10:00.000Z",
    })
    const store = new SqliteWorkspaceStore(":memory:", recovered)
    let matchingTransfer = false
    const remoteCall = vi.fn(async (method: string) => {
      if (method !== "transfer.status") throw new Error(`Unexpected ${method}`)
      return {
        state: "committed",
        transferId: matchingTransfer
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
      authToken: "correct-horse-battery-staple",
      connectToMachine: async () => ({ call: remoteCall, close: () => {} }),
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)

    await daemon.start()
    await vi.waitFor(() => expect(remoteCall).toHaveBeenCalledOnce())
    expect(store.load().sessions[0]?.state).toBe("idle")
    matchingTransfer = true
    const socket = await openClient(daemon)
    await rpc(socket)("fleet.list", {})
    await vi.waitFor(() => expect(store.load().sessions[0]?.state).toBe("ownership-conflict"))

    expect(store.load().sessions[0]).toMatchObject({
      state: "ownership-conflict",
      workspacePath: "/source/session",
      sourceRecovery: {
        transferId: packaged.manifest.transferId,
        decidedBy: { client: "desktop", clientId: "studio-mac" },
      },
      ownershipConflict: {
        transferId: packaged.manifest.transferId,
        otherMachineId: targetMachineId,
        otherGeneration: 2,
        recoveryAction: "none",
      },
    })
    expect(store.load().thread.at(-1)).toMatchObject({
      kind: "system",
      body: "Session ownership conflict detected.",
    })
    socket.close()
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
      protocolVersion: "0.1.0",
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    let checkpointed = false
    let statusCalls = 0
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
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
      client: "desktop",
    })
    const approved = preview.result as { contractVersion: 1; intentDigest: string }

    await expect(call("session.transfer", {
      sessionId: source.sessions[0]!.id,
      targetMachineId,
      client: "desktop",
      contractVersion: approved.contractVersion,
      intentDigest: approved.intentDigest,
    })).resolves.toMatchObject({
      result: {
        outcome: "incomplete",
        state: "unknown",
        recoveryAction: "check-status",
      },
    })
    await vi.waitFor(() => expect(store.load().sessions[0]?.state).toBe("transferred"))
    expect(statusCalls).toBe(2)
    socket.close()
  })

  it("accepts, restores, and idempotently commits a transfer from its source machine", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-rpc-"))
    scratchDirectories.push(scratch)
    const transactions = new FileTransferTransactions(join(scratch, "transactions"))
    const snapshot = targetSnapshot()
    const workspaceService = {
      inspect: async () => ({ root: "/target/project", name: "project", branch: "main", head: baseCommit }),
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
    } satisfies WorkspaceService
    const daemon = new DomovoiDaemon({
      port: 0,
      store: new SqliteWorkspaceStore(":memory:", snapshot),
      authToken: "correct-horse-battery-staple",
      workspaceService,
      transferTransactions: transactions,
      artifactWatcherFactory: () => ({ start: async () => {}, stop: () => {} }),
    })
    running.push(daemon)
    await daemon.start()
    const socket = await openMachine(daemon)
    const call = rpc(socket)
    const packaged = await packagedTransfer()

    await expect(call("transfer.preflight", {
      sessionId: packaged.manifest.sessionId,
      sourceMachineId,
      sourceProjectId: packaged.manifest.project.sourceProjectId,
      lineageCommit: baseCommit,
      ownershipGeneration: packaged.manifest.ownership.fromGeneration,
      client: "desktop",
    })).resolves.toMatchObject({
      result: { allowed: true, targetProjectId: "project-target" },
    })
    await expect(call("transfer.prepare", {
      manifest: packaged.manifest,
      manifestDigest: packaged.manifestDigest,
      client: "desktop",
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
        client: "desktop",
      })
    }
    const commitParams = {
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      client: "desktop",
    }
    await expect(call("transfer.commit", commitParams)).resolves.toMatchObject({
      result: {
        state: "committed",
        checkpointCommit,
        ownershipGeneration: 2,
      },
    })
    await expect(call("transfer.commit", commitParams)).resolves.toMatchObject({
      result: { state: "committed" },
    })
    await expect(call("transfer.status", commitParams)).resolves.toMatchObject({
      result: { state: "committed" },
    })
    await transactions.remove(packaged.manifest.transferId, packaged.manifestDigest)
    await expect(call("transfer.status", commitParams)).resolves.toMatchObject({
      result: {
        state: "committed",
        checkpointCommit,
        ownershipGeneration: 2,
      },
    })

    const loaded = workspaceSnapshotSchema.parse((await call("workspace.get", {})).result)
    expect(loaded.sessions).toHaveLength(1)
    expect(loaded.sessions[0]).toMatchObject({
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
    expect(loaded.thread.filter((item) => item.id.startsWith("system-transfer-")))
      .toHaveLength(1)
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
      protocolVersion: "0.1.0",
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    const remoteCalls: Array<{ method: string, params: Record<string, unknown> }> = []
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
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

    await expect(call("session.transferPreview", {
      sessionId: session.id,
      targetMachineId,
      client: "desktop",
    })).resolves.toMatchObject({
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
    expect(remoteCalls).toEqual([{
      method: "transfer.preflight",
      params: {
        sessionId: session.id,
        sourceMachineId,
        sourceProjectId: source.project.id,
        lineageCommit: baseCommit,
        ownershipGeneration: 3,
        client: "desktop",
      },
    }])
    remoteCalls.length = 0
    await expect(call("session.transfer", {
      sessionId: session.id,
      targetMachineId,
      client: "desktop",
    })).resolves.toMatchObject({
      error: { code: -32602, message: "Method parameters are invalid" },
    })
    expect(remoteCalls).toEqual([])
    expect((store.load().sessions[0])?.state).toBe("idle")
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
      protocolVersion: "0.1.0",
      transports: [{ kind: "local", endpoint: "ws://studio/rpc", authenticated: true }],
    }, Date.now())
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    const targetTransactions = new FileTransferTransactions(join(scratch, "target"))
    let checkpointed = false
    let observedStagedSource = false
    const daemon = new DomovoiDaemon({
      port: 0,
      store,
      authToken: "correct-horse-battery-staple",
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
      client: "desktop",
    })
    const approved = preview.result as { contractVersion: 1, intentDigest: string }

    const moved = await call("session.transfer", {
      sessionId: session.id,
      targetMachineId,
      client: "desktop",
      contractVersion: approved.contractVersion,
      intentDigest: approved.intentDigest,
    })
    expect(moved.result).toMatchObject({
      outcome: "succeeded",
      contractVersion: 1,
      ownershipGeneration: 4,
    })
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
})
