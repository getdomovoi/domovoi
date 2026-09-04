import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
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

async function packagedTransfer() {
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
  return createSessionTransferPackage(intent, {
    transferId: `transfer-${"f".repeat(32)}`,
    checkpointCommit,
    repository: { method: "git-bundle", bytes: Buffer.from("repository") },
    createdAt: "2026-09-03T22:00:00.000Z",
  })
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

async function openMachine(daemon: DomovoiDaemon): Promise<WebSocket> {
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
    machineId: sourceMachineId,
    clientVersion: "0.0.1",
    protocolVersion: "0.1.0",
  })
  return socket
}

describe("transactional session transfer RPC", () => {
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
})
