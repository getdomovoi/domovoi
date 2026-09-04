import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  sessionTransferManifestSchema,
  transferMemberChunkBytes,
  type SessionTransferManifest,
} from "@getdomovoi/protocol"

import { sessionTransferManifestDigest } from "./session-transfer-package.js"
import { FileTransferTransactions, writeAllTransferBytes } from "./transfer-transactions.js"

const renameSimulation = vi.hoisted(() => ({
  existingDirectoryIsBusy: false,
  rejectOverlappingTargets: false,
  activeTargets: new Set<string>(),
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
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
  await Promise.all(scratchDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

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
      client: "desktop",
    })).resolves.toMatchObject({ state: "refused", reason: "chunk-out-of-order" })
    await expect(transactions.acceptMember({
      transferId,
      memberId: "state",
      sequence: 0,
      bytes: stateBytes.toString("base64"),
      final: true,
      client: "desktop",
    })).resolves.toEqual({ state: "member-received", transferId, memberId: "state" })

    const reopened = new FileTransferTransactions(root)
    await expect(reopened.acceptMember({
      transferId,
      memberId: "repository",
      sequence: 0,
      bytes: firstRepositoryChunk.toString("base64"),
      final: false,
      client: "desktop",
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
      client: "desktop",
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
      client: "desktop",
    })

    const chunk = {
      transferId,
      memberId: "repository",
      sequence: 0,
      bytes: repositoryBytes.toString("base64"),
      final: true,
      client: "desktop" as const,
    }
    renameSimulation.rejectOverlappingTargets = true
    const results = await Promise.allSettled(
      Array.from({ length: 256 }, () => transactions.acceptMember(chunk)),
    )

    expect(results.filter((result) => result.status === "rejected")).toEqual([])
    await expect(transactions.status(transferId, manifestDigest))
      .resolves.toEqual({ state: "prepared", transferId })
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
      client: "desktop",
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
      client: "desktop",
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
      client: "desktop",
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
      client: "desktop",
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
      client: "desktop",
    })
    await transactions.acceptMember({
      transferId,
      memberId: "repository",
      sequence: 0,
      bytes: repositoryBytes.toString("base64"),
      final: true,
      client: "desktop",
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
