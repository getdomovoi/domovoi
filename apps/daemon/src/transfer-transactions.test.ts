import { createHash } from "node:crypto"
import { EventEmitter, once } from "node:events"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createEmptyWorkspace,
  demoWorkspace,
  sessionTransferManifestSchema,
  transferMemberChunkBytes,
  type SessionTransferManifest,
} from "@getdomovoi/protocol"

import { sessionTransferManifestDigest } from "./session-transfer-package.js"
import { FileTransferTransactions, writeAllTransferBytes } from "./transfer-transactions.js"
import { OperationDeadline } from "./operation-deadline.js"
import { daemonWaitTimeoutMs } from "./test-wait-for.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { openMachineSocket } from "./machine-socket.js"
import type { MachineConnection } from "./machine-dial.js"
import { ResourceMutationQueue } from "./resource-mutation-queue.js"

const renameSimulation = vi.hoisted(() => ({
  existingDirectoryIsBusy: false,
  rejectOverlappingTargets: false,
  activeTargets: new Set<string>(),
}))

const chunkReadSimulation = vi.hoisted(() => ({
  path: undefined as string | undefined,
  pause: undefined as (() => Promise<void>) | undefined,
  openDirectories: new Set<string>(),
  blockedRemovals: [] as string[],
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = chunkReadSimulation.path
      const pause = chunkReadSimulation.pause
      if (path && args[0] === path && pause) {
        chunkReadSimulation.pause = undefined
        const handle = await actual.open(path, "r")
        chunkReadSimulation.openDirectories.add(dirname(path))
        try {
          await pause()
          return await handle.readFile(args[1])
        } finally {
          await handle.close()
          chunkReadSimulation.openDirectories.delete(dirname(path))
        }
      }
      return actual.readFile(...args)
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const path = String(args[0])
      if (chunkReadSimulation.openDirectories.has(path)) {
        chunkReadSimulation.blockedRemovals.push(path)
        throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${path}'`), {
          code: "EPERM", errno: -4048, syscall: "rmdir", path,
        })
      }
      return actual.rm(...args)
    },
    rename: async (oldPath: string, newPath: string) => {
      if (renameSimulation.existingDirectoryIsBusy) {
        try {
          if ((await actual.stat(newPath)).isDirectory()) {
            throw Object.assign(new Error("destination directory is busy"), { code: "EPERM" })
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      if (renameSimulation.rejectOverlappingTargets) {
        if (renameSimulation.activeTargets.has(newPath)) {
          throw Object.assign(new Error("destination file is busy"), { code: "EPERM" })
        }
        renameSimulation.activeTargets.add(newPath)
        await new Promise((resolve) => setTimeout(resolve, 5))
        try {
          return await actual.rename(oldPath, newPath)
        } finally {
          renameSimulation.activeTargets.delete(newPath)
        }
      }
      return actual.rename(oldPath, newPath)
    },
  }
})

const scratchDirectories: string[] = []
const transferId = `transfer-${"a".repeat(32)}`
const secondTransferId = `transfer-${"d".repeat(32)}`
const sourceMachineId = `machine-${"b".repeat(32)}`
const targetMachineId = `machine-${"c".repeat(32)}`
const sha256 = (character: string) => `sha256:${character.repeat(64)}`
const memberJournalKey = (memberId: string) => createHash("sha256")
  .update("domovoi.transfer-member-path.v1\0")
  .update(memberId)
  .digest("hex")

afterEach(async () => {
  renameSimulation.existingDirectoryIsBusy = false
  renameSimulation.rejectOverlappingTargets = false
  renameSimulation.activeTargets.clear()
  chunkReadSimulation.path = undefined
  chunkReadSimulation.pause = undefined
  chunkReadSimulation.openDirectories.clear()
  chunkReadSimulation.blockedRemovals.length = 0
  await Promise.all(scratchDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

function within<T>(deadline: OperationDeadline, operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    deadline.throwIfExpired()
    const detach = () => deadline.signal.removeEventListener("abort", abort)
    const abort = () => { detach(); reject(deadline.signal.reason) }
    deadline.signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => { deadline.throwIfExpired(); return operation() }).then((value) => {
      deadline.throwIfExpired()
      resolve(value)
    }).catch(reject).finally(detach)
  })
}

async function journal() {
  const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-journal-"))
  scratchDirectories.push(scratch)
  const root = join(scratch, "transactions")
  return { root, transactions: new FileTransferTransactions(root) }
}

function manifestFor(
  stateBytes: Buffer,
  repositoryBytes: Buffer,
  id = transferId,
): SessionTransferManifest {
  const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  return sessionTransferManifestSchema.parse({
    version: 1,
    transferId: id,
    sessionId: "session-1",
    sourceMachineId,
    targetMachineId,
    intentDigest: sha256("d"),
    createdAt: "2026-09-03T21:00:00.000Z",
    ownership: { fromGeneration: 1, toGeneration: 2 },
    project: {
      sourceProjectId: "project-source",
      targetProjectId: "project-target",
      lineageCommit: "e".repeat(40),
      checkpointCommit: "f".repeat(40),
    },
    repository: { method: "git-bundle", memberId: "repository" },
    stateMemberId: "state",
    members: [
      {
        memberId: "state",
        kind: "session-state",
        digest: digest(stateBytes),
        byteLength: stateBytes.byteLength,
      },
      {
        memberId: "repository",
        kind: "repository-bundle",
        digest: digest(repositoryBytes),
        byteLength: repositoryBytes.byteLength,
      },
    ],
    totalBytes: stateBytes.byteLength + repositoryBytes.byteLength,
    coverage: { included: [], excluded: [], warnings: [] },
  })
}

describe("file transfer transaction journal", () => {
  it("retries short filesystem writes until every member byte is durable", async () => {
    const writes: Buffer[] = []
    const writer = {
      async write(bytes: Uint8Array, offset: number, length: number) {
        const bytesWritten = Math.min(2, length)
        writes.push(Buffer.from(bytes.subarray(offset, offset + bytesWritten)))
        return { bytesWritten }
      },
    }

    await writeAllTransferBytes(writer, Buffer.from("transfer"))

    expect(Buffer.concat(writes).toString("utf8")).toBe("transfer")
    expect(writes).toHaveLength(4)
  })

  it("prepares the same manifest idempotently across process restarts", async () => {
    const { root, transactions } = await journal()
    const manifest = manifestFor(Buffer.from("state"), Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)

    await expect(transactions.prepare(manifest, manifestDigest)).resolves.toEqual({
      state: "receiving",
      transferId,
      missingMemberIds: ["state", "repository"],
    })
    const reopened = new FileTransferTransactions(root)
    await expect(reopened.prepare(manifest, manifestDigest)).resolves.toEqual({
      state: "receiving",
      transferId,
      missingMemberIds: ["state", "repository"],
    })
    await expect(reopened.prepare(manifest, sha256("0"))).resolves.toEqual({
      state: "refused",
      transferId,
      reason: "digest-mismatch",
    })
  })

  it("adopts an existing journal when Windows reports its directory as busy", async () => {
    const { root, transactions } = await journal()
    const manifest = manifestFor(Buffer.from("state"), Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    renameSimulation.existingDirectoryIsBusy = true

    await expect(new FileTransferTransactions(root).prepare(manifest, manifestDigest))
      .resolves.toEqual({
        state: "receiving",
        transferId,
        missingMemberIds: ["state", "repository"],
      })
  })

  it("serializes concurrent durable journal publications by destination", async () => {
    const { transactions } = await journal()
    const manifest = manifestFor(Buffer.from("state"), Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    renameSimulation.rejectOverlappingTargets = true

    await expect(Promise.all(Array.from({ length: 32 }, () => (
      transactions.markFailed(transferId, manifestDigest, "state-import-failed")
    )))).resolves.toHaveLength(32)
    await expect(transactions.status(transferId, manifestDigest)).resolves.toEqual({
      state: "failed",
      transferId,
      reason: "state-import-failed",
    })
  })

  it("streams members durably, refuses gaps, and verifies their digest", async () => {
    const { root, transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const firstRepositoryChunk = Buffer.alloc(transferMemberChunkBytes, 7)
    const finalRepositoryChunk = Buffer.from("repository")
    const repositoryBytes = Buffer.concat([firstRepositoryChunk, finalRepositoryChunk])
    const manifest = manifestFor(stateBytes, repositoryBytes)
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)

    await expect(transactions.acceptMember({
      transferId,
      memberId: "state",
      sequence: 1,
      bytes: stateBytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })).resolves.toMatchObject({ state: "refused", reason: "chunk-out-of-order" })
    await expect(transactions.acceptMember({
      transferId,
      memberId: "state",
      sequence: 0,
      bytes: stateBytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })).resolves.toEqual({ state: "member-received", transferId, memberId: "state" })

    const reopened = new FileTransferTransactions(root)
    await expect(reopened.acceptMember({
      transferId,
      memberId: "repository",
      sequence: 0,
      bytes: firstRepositoryChunk.toString("base64"),
      final: false,
      initiatedByClient: "desktop",
    })).resolves.toEqual({
      state: "receiving",
      transferId,
      memberId: "repository",
      nextSequence: 1,
    })
    await expect(reopened.acceptMember({
      transferId,
      memberId: "repository",
      sequence: 1,
      bytes: finalRepositoryChunk.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })).resolves.toEqual({ state: "prepared", transferId })
    await expect(reopened.readMember(transferId, manifestDigest, "repository"))
      .resolves.toEqual(repositoryBytes)
    await expect(reopened.status(transferId, manifestDigest))
      .resolves.toEqual({ state: "prepared", transferId })
  })

  it("handles concurrent retries of the same chunk without throwing", async () => {
    const { transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const repositoryBytes = Buffer.from("repository")
    const manifest = manifestFor(stateBytes, repositoryBytes)
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    await transactions.acceptMember({
      transferId,
      memberId: "state",
      sequence: 0,
      bytes: stateBytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })

    const chunk = {
      transferId,
      memberId: "repository",
      sequence: 0,
      bytes: repositoryBytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop" as const,
    }
    renameSimulation.rejectOverlappingTargets = true
    // Exercise overlapping publication, not a 256-write durable-flush backlog.
    // The rename simulation makes an overlapping writer fail even at this size.
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () => transactions.acceptMember(chunk)),
    )

    expect(results.filter((result) => result.status === "rejected")).toEqual([])
    await expect(transactions.status(transferId, manifestDigest))
      .resolves.toEqual({ state: "prepared", transferId })
  }, 20_000)

  it("does not remove a chunk directory while another receive holds its file open", async () => {
    const { root, transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const repositoryBytes = Buffer.from("repository")
    const manifest = manifestFor(stateBytes, repositoryBytes)
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    const chunkPath = join(root, transferId, "chunks", memberJournalKey("state"))
    await mkdir(chunkPath)
    await writeFile(join(chunkPath, "0-1.chunk"), stateBytes, { mode: 0o600 })
    const chunk = {
      transferId, memberId: "state", sequence: 0,
      bytes: stateBytes.toString("base64"), final: true, initiatedByClient: "desktop" as const,
    }
    const deadline = OperationDeadline.start(daemonWaitTimeoutMs(process.platform))
    const gate = new EventEmitter()
    const opened = once(gate, "opened", { signal: deadline.signal })
    chunkReadSimulation.path = join(chunkPath, "0-1.chunk")
    chunkReadSimulation.pause = async () => {
      // An actual file handle is open here. Linux permits deleting it; the
      // rm adapter models Windows refusing rmdir until this handle closes.
      const released = once(gate, "release", { signal: deadline.signal })
      gate.emit("opened")
      await released
    }
    const first = Promise.allSettled([transactions.acceptMember(chunk)])
    try {
      await opened
      const retry = new FileTransferTransactions(root)
      const retries = await within(deadline, () => Promise.allSettled([retry.acceptMember(chunk)]))
      expect(retries).toEqual([{
        status: "fulfilled",
        value: { state: "refused", transferId, reason: "chunk-out-of-order" },
      }])
      expect(chunkReadSimulation.blockedRemovals).toEqual([])
      // The guard is per member, shared by instances using the same journal.
      // A different member must still make progress while this read is held.
      await expect(within(deadline, () => retry.acceptMember({
        ...chunk, memberId: "repository", bytes: repositoryBytes.toString("base64"),
      }))).resolves.toEqual({ state: "member-received", transferId, memberId: "repository" })
    } finally {
      gate.emit("release")
      const cleanup = OperationDeadline.start(daemonWaitTimeoutMs(process.platform))
      try { await within(cleanup, () => first) } finally { cleanup.clear(); deadline.clear() }
    }
    await expect(first).resolves.toEqual([{ status: "fulfilled", value: { state: "prepared", transferId } }])
    await expect(transactions.readMember(transferId, manifestDigest, "state")).resolves.toEqual(stateBytes)
    await expect(transactions.readMember(transferId, manifestDigest, "repository")).resolves.toEqual(repositoryBytes)
    // Once the owner finishes, retrying is ordinarily idempotent again.
    await expect(transactions.acceptMember(chunk)).resolves.toEqual({ state: "prepared", transferId })
  })

  it("releases a member reservation after a chunk read fails", async () => {
    const { root, transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const manifest = manifestFor(stateBytes, Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    const chunkPath = join(root, transferId, "chunks", memberJournalKey("state"))
    await mkdir(chunkPath)
    await writeFile(join(chunkPath, "0-1.chunk"), stateBytes, { mode: 0o600 })
    const failure = new Error("chunk read failed")
    chunkReadSimulation.path = join(chunkPath, "0-1.chunk")
    chunkReadSimulation.pause = async () => { throw failure }
    const chunk = {
      transferId, memberId: "state", sequence: 0,
      bytes: stateBytes.toString("base64"), final: true, initiatedByClient: "desktop" as const,
    }
    await expect(transactions.acceptMember(chunk)).rejects.toBe(failure)
    await expect(new FileTransferTransactions(root).acceptMember(chunk))
      .resolves.toEqual({ state: "member-received", transferId, memberId: "state" })
    await expect(transactions.readMember(transferId, manifestDigest, "state")).resolves.toEqual(stateBytes)
  })

  it.each(["retry", "abort"] as const)("queues a reconnected %s behind the disconnected receive", async (action) => {
    const { root, transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const manifest = manifestFor(stateBytes, Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    const chunkPath = join(root, transferId, "chunks", memberJournalKey("state"))
    await mkdir(chunkPath)
    await writeFile(join(chunkPath, "0-1.chunk"), stateBytes, { mode: 0o600 })
    const store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace({
      ...demoWorkspace.machine, id: targetMachineId,
    }))
    const credential = store.devices.pair({
      label: "source", binding: { kind: "machine", machineId: sourceMachineId },
    }).token
    const daemon = new DomovoiDaemon({
      port: 0, store, statePath: join(root, "state.sqlite"), transferTransactions: transactions,
      outgoingTransferTransactions: new FileTransferTransactions(join(root, "outgoing")),
    })
    const receives = vi.spyOn(transactions, "acceptMember")
    const aborts = vi.spyOn(transactions, "abort")
    const queued = vi.spyOn(ResourceMutationQueue.prototype, "enqueue")
    const budgetMs = daemonWaitTimeoutMs(process.platform)
    const deadline = OperationDeadline.start(budgetMs)
    const gate = new EventEmitter()
    const connections: MachineConnection[] = []
    try {
      const address = await within(deadline, () => daemon.start())
      const connect = async () => {
        const connection = await openMachineSocket({
          endpoint: `ws://${address.host}:${address.port}/rpc`,
          expectedMachineId: targetMachineId, credential, deadline, callTimeoutMs: budgetMs,
        })
        connections.push(connection)
        return connection
      }
      const first = await connect()
      const opened = once(gate, "opened", { signal: deadline.signal })
      chunkReadSimulation.path = join(chunkPath, "0-1.chunk")
      chunkReadSimulation.pause = async () => {
        const released = once(gate, "release", { signal: deadline.signal })
        gate.emit("opened")
        await released
      }
      const chunk = {
        transferId, memberId: "state", sequence: 0,
        bytes: stateBytes.toString("base64"), final: true, initiatedByClient: "desktop",
      }
      const lostReply = Promise.allSettled([first.call("transfer.member", chunk, undefined, deadline)])
      await opened
      first.close()
      await expect(lostReply).resolves.toMatchObject([{ status: "rejected" }])
      const reconnected = await connect()
      const reply = Promise.allSettled([action === "retry"
        ? reconnected.call("transfer.member", chunk, undefined, deadline)
        : reconnected.call("transfer.abort", { transferId, manifestDigest, initiatedByClient: "desktop" }, undefined, deadline)])
      // This later frame bypasses the mutation queue. Its reply proves the
      // target has received the preceding retry or abort on the new socket.
      await reconnected.call("fleet.heartbeat", {}, undefined, deadline)
      // Pin shared routing too: the heartbeat does not wait for an unqueued
      // handler's initial filesystem reads, so a call-count check alone can
      // miss a bypass that has not reached the journal yet.
      expect(queued.mock.calls.map(([resource]) => resource).filter((resource) => (
        resource.startsWith(`transfer:${transferId}`)
      ))).toEqual([`transfer:${transferId}`, `transfer:${transferId}`])
      expect(receives).toHaveBeenCalledTimes(1)
      expect(aborts).not.toHaveBeenCalled()
      expect(chunkReadSimulation.blockedRemovals).toEqual([])
      gate.emit("release")
      await expect(reply).resolves.toEqual([{
        status: "fulfilled",
        value: action === "retry"
          ? { state: "member-received", transferId, memberId: "state" }
          : { state: "aborted", transferId },
      }])
      const originalReceive = receives.mock.results[0]
      expect(originalReceive?.type).toBe("return")
      if (originalReceive?.type === "return") {
        await expect(originalReceive.value).resolves.toEqual({ state: "member-received", transferId, memberId: "state" })
      }
      if (action === "retry") {
        await expect(transactions.readMember(transferId, manifestDigest, "state")).resolves.toEqual(stateBytes)
      } else {
        await expect(transactions.status(transferId, manifestDigest)).resolves.toEqual({ state: "aborted", transferId })
      }
    } finally {
      gate.emit("release")
      for (const connection of connections) connection.close()
      const cleanup = OperationDeadline.start(budgetMs)
      try {
        await within(cleanup, async () => {
          // A closed socket is not evidence the original receive settled.
          await Promise.allSettled(receives.mock.results.flatMap((result) => (
            result.type === "return" ? [result.value] : []
          )))
          await daemon.stop()
        })
      } finally {
        cleanup.clear(); deadline.clear()
        receives.mockRestore(); aborts.mockRestore(); queued.mockRestore()
      }
    }
  })

  it("publishes a final chunk retained across a process restart", async () => {
    const { root, transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const manifest = manifestFor(stateBytes, Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    const chunkPath = join(root, transferId, "chunks", memberJournalKey("state"))
    await mkdir(chunkPath)
    await writeFile(join(chunkPath, "0-1.chunk"), stateBytes, { mode: 0o600 })

    const reopened = new FileTransferTransactions(root)
    await expect(reopened.acceptMember({
      transferId,
      memberId: "state",
      sequence: 0,
      bytes: stateBytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })).resolves.toEqual({ state: "member-received", transferId, memberId: "state" })
    await expect(reopened.readMember(transferId, manifestDigest, "state"))
      .resolves.toEqual(stateBytes)
  })

  it("stores maximum-length member ids without using them as filesystem names", async () => {
    const { transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const longMemberId = "a".repeat(256)
    const base = manifestFor(stateBytes, Buffer.from("repository"))
    const manifest = sessionTransferManifestSchema.parse({
      ...base,
      stateMemberId: longMemberId,
      members: base.members.map((member) => (
        member.kind === "session-state" ? { ...member, memberId: longMemberId } : member
      )),
    })
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)

    await expect(transactions.acceptMember({
      transferId,
      memberId: longMemberId,
      sequence: 0,
      bytes: stateBytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })).resolves.toEqual({
      state: "member-received",
      transferId,
      memberId: longMemberId,
    })
    await expect(transactions.readMember(transferId, manifestDigest, longMemberId))
      .resolves.toEqual(stateBytes)
  })

  it("does not publish a member whose bytes miss its declared digest", async () => {
    const { transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const manifest = manifestFor(stateBytes, Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)

    await expect(transactions.acceptMember({
      transferId,
      memberId: "state",
      sequence: 0,
      bytes: Buffer.from("wrong").toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })).resolves.toMatchObject({ state: "refused", reason: "digest-mismatch" })
    await expect(transactions.readMember(transferId, manifestDigest, "state"))
      .rejects.toThrow("Transfer member is incomplete")
  })

  it("does not resurrect an aborted transaction through a late member", async () => {
    const { transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const manifest = manifestFor(stateBytes, Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    await expect(transactions.abort(transferId, manifestDigest))
      .resolves.toEqual({ state: "aborted", transferId })

    await expect(transactions.acceptMember({
      transferId,
      memberId: "state",
      sequence: 0,
      bytes: stateBytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })).resolves.toEqual({
      state: "refused",
      transferId,
      reason: "session-state-changed",
    })
    await expect(transactions.status(transferId, manifestDigest))
      .resolves.toEqual({ state: "aborted", transferId })
  })

  it("records recovery and commit before an acknowledgement can be lost", async () => {
    const { root, transactions } = await journal()
    const manifest = manifestFor(Buffer.from("state"), Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    await transactions.markRecovering(transferId, manifestDigest, "persistence")
    await expect(new FileTransferTransactions(root).status(transferId, manifestDigest))
      .resolves.toEqual({ state: "recovering", transferId, stage: "persistence" })

    const committed = {
      state: "committed" as const,
      transferId,
      workspacePath: "/worktrees/session-1",
      checkpointCommit: "f".repeat(40),
      ownershipGeneration: 2,
    }
    await transactions.markCommitted(transferId, manifestDigest, committed)
    const reopened = new FileTransferTransactions(root)
    await expect(reopened.status(transferId, manifestDigest)).resolves.toEqual(committed)
    await expect(reopened.markRecovering(transferId, manifestDigest, "resources"))
      .rejects.toThrow("committed")
    await expect(reopened.markFailed(transferId, manifestDigest, "resource-import-failed"))
      .rejects.toThrow("committed")
    await expect(reopened.status(transferId, manifestDigest)).resolves.toEqual(committed)
    await expect(reopened.abort(transferId, manifestDigest)).resolves.toEqual(committed)
  })

  it("removes only the exact terminal transaction and all of its bytes", async () => {
    const { transactions } = await journal()
    const stateBytes = Buffer.from("state")
    const repositoryBytes = Buffer.from("repository")
    const manifest = manifestFor(stateBytes, repositoryBytes)
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    await transactions.acceptMember({
      transferId,
      memberId: "state",
      sequence: 0,
      bytes: stateBytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })
    await transactions.acceptMember({
      transferId,
      memberId: "repository",
      sequence: 0,
      bytes: repositoryBytes.toString("base64"),
      final: true,
      initiatedByClient: "desktop",
    })

    await expect(transactions.remove(transferId, sha256("0")))
      .rejects.toThrow("Transfer manifest digest changed")
    await expect(transactions.readMember(transferId, manifestDigest, "repository"))
      .resolves.toEqual(repositoryBytes)

    await transactions.remove(transferId, manifestDigest)
    await expect(transactions.status(transferId, manifestDigest))
      .resolves.toEqual({ state: "unknown", transferId })
  })

  it("prunes abandoned packages by durable last activity", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-retention-"))
    scratchDirectories.push(scratch)
    let now = 1_000
    const transactions = new FileTransferTransactions(join(scratch, "transactions"), {
      retentionMs: 100,
      now: () => now,
    })
    const first = manifestFor(Buffer.from("first-state"), Buffer.from("first-repository"))
    const firstDigest = sessionTransferManifestDigest(first)
    await transactions.prepare(first, firstDigest)
    now = 1_050
    const second = manifestFor(
      Buffer.from("second-state"),
      Buffer.from("second-repository"),
      secondTransferId,
    )
    const secondDigest = sessionTransferManifestDigest(second)
    await transactions.prepare(second, secondDigest)

    now = 1_110
    await expect(transactions.pruneExpired()).resolves.toEqual([transferId])
    await expect(transactions.status(transferId, firstDigest))
      .resolves.toEqual({ state: "unknown", transferId })
    await expect(transactions.status(secondTransferId, secondDigest))
      .resolves.toMatchObject({ state: "receiving", transferId: secondTransferId })
  })

  it("does not let a missing activity marker evade the retention bound", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-transfer-retention-fallback-"))
    scratchDirectories.push(scratch)
    const root = join(scratch, "transactions")
    const transactions = new FileTransferTransactions(root, {
      retentionMs: 100,
      now: () => 2_000,
    })
    const manifest = manifestFor(Buffer.from("state"), Buffer.from("repository"))
    const manifestDigest = sessionTransferManifestDigest(manifest)
    await transactions.prepare(manifest, manifestDigest)
    await rm(join(root, transferId, "activity.json"))
    await utimes(join(root, transferId), new Date(1_000), new Date(1_000))

    await expect(transactions.pruneExpired()).resolves.toEqual([transferId])
    await expect(transactions.status(transferId, manifestDigest))
      .resolves.toEqual({ state: "unknown", transferId })
  })
})
