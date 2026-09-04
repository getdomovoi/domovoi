import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import {
  createSessionTransferPackage,
  prepareSessionTransferIntent,
} from "./session-transfer-package.js"
import {
  completeSourceSessionTransfer,
  freezeSourceSessionTransfer,
  sendPreparedSessionTransfer,
  stageOutgoingSessionTransferPackage,
  stageSourceSessionCheckpoint,
} from "./session-transfer-source.js"
import { FileTransferTransactions } from "./transfer-transactions.js"

const scratchDirectories: string[] = []
const sourceMachineId = `machine-${"a".repeat(32)}`
const targetMachineId = `machine-${"b".repeat(32)}`
const baseCommit = "c".repeat(40)
const checkpointCommit = "d".repeat(40)

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

async function transferFixture(repositoryBytes = Buffer.from("repository")) {
  const source = structuredClone(demoWorkspace)
  source.machine.id = sourceMachineId
  source.project!.machineId = sourceMachineId
  const session = source.sessions.find((candidate) => candidate.state === "idle")!
  session.runtime = {
    provider: "claude-code",
    model: "claude-opus-5",
    reasoning: "high",
    permissionMode: "build",
    auto: true,
  }
  session.workspacePath = "/source/session"
  session.providerThreadId = "thread-1"
  session.baseCommit = baseCommit
  session.ownershipGeneration = 4
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
    repository: { method: "git-bundle", bytes: repositoryBytes },
    createdAt: "2026-09-03T22:00:00.000Z",
  })
  return { source, session, intent, packaged }
}

describe("source transfer lifecycle", () => {
  it("freezes before transfer and advances ownership only after target commit", async () => {
    const { source, session, intent, packaged } = await transferFixture()
    const frozen = freezeSourceSessionTransfer(
      source,
      intent,
      packaged.manifest.transferId,
      "2026-09-03T22:00:00.000Z",
    )
    expect(frozen.sessions[0]).toMatchObject({
      id: session.id,
      state: "transferring",
      ownershipGeneration: 4,
      transfer: {
        phase: "transferring",
        transferId: packaged.manifest.transferId,
        targetMachineId,
        intentDigest: intent.preview.intentDigest,
        nextGeneration: 5,
        resumeState: "idle",
        package: { state: "preparing" },
      },
    })

    const staged = stageSourceSessionCheckpoint(frozen, packaged.manifest)
    expect(staged.sessions[0]?.baseCommit).toBe(checkpointCommit)
    expect(staged.sessions[0]?.transfer).toMatchObject({
      package: { state: "staged", manifestDigest: packaged.manifestDigest },
    })
    const completed = completeSourceSessionTransfer(staged, {
      state: "committed",
      transferId: packaged.manifest.transferId,
      workspacePath: "/target/session",
      checkpointCommit,
      ownershipGeneration: 5,
    }, "2026-09-03T22:01:00.000Z")
    expect(completed.sessions[0]).toMatchObject({
      state: "transferred",
      ownershipGeneration: 5,
      runtime: { auto: false },
      transfer: {
        phase: "transferred",
        transferId: packaged.manifest.transferId,
        targetMachineId,
        generation: 5,
        manifestDigest: packaged.manifestDigest,
      },
    })
    expect(completed.sessions[0]).not.toHaveProperty("providerThreadId")
  })
})

describe("prepared source transfer delivery", () => {
  it("journals every byte before streaming only the target's missing members", async () => {
    const repositoryBytes = Buffer.alloc(600_000, 7)
    const { packaged } = await transferFixture(repositoryBytes)
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-outgoing-transfer-"))
    scratchDirectories.push(scratch)
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    await stageOutgoingSessionTransferPackage(outgoing, packaged)

    const chunks: Array<{ memberId: string; sequence: number; final: boolean; bytes: Buffer }> = []
    const call = vi.fn(async (method: string, raw: Record<string, unknown>) => {
      if (method === "transfer.status") {
        return { state: "unknown", transferId: packaged.manifest.transferId }
      }
      if (method === "transfer.prepare") {
        return {
          state: "receiving",
          transferId: packaged.manifest.transferId,
          missingMemberIds: ["repository"],
        }
      }
      if (method === "transfer.member") {
        chunks.push({
          memberId: String(raw.memberId),
          sequence: Number(raw.sequence),
          final: Boolean(raw.final),
          bytes: Buffer.from(String(raw.bytes), "base64"),
        })
        return raw.final
          ? { state: "prepared", transferId: packaged.manifest.transferId }
          : {
              state: "receiving",
              transferId: packaged.manifest.transferId,
              memberId: raw.memberId,
              nextSequence: Number(raw.sequence) + 1,
            }
      }
      return {
        state: "committed",
        transferId: packaged.manifest.transferId,
        workspacePath: "/target/session",
        checkpointCommit,
        ownershipGeneration: 5,
      }
    })

    await expect(sendPreparedSessionTransfer({
      transactions: outgoing,
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      client: "desktop",
      call,
    })).resolves.toMatchObject({ state: "committed", ownershipGeneration: 5 })
    expect(chunks.map(({ memberId }) => memberId)).toEqual([
      "repository",
      "repository",
      "repository",
    ])
    expect(chunks.map(({ sequence, final }) => ({ sequence, final }))).toEqual([
      { sequence: 0, final: false },
      { sequence: 1, final: false },
      { sequence: 2, final: true },
    ])
    expect(Buffer.concat(chunks.map(({ bytes }) => bytes))).toEqual(repositoryBytes)
  })

  it("reports durable recovery instead of competing with a target already committing", async () => {
    const { packaged } = await transferFixture()
    const call = vi.fn(async () => ({
      state: "recovering",
      transferId: packaged.manifest.transferId,
      stage: "persistence",
    }))
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-outgoing-recovery-"))
    scratchDirectories.push(scratch)

    await expect(sendPreparedSessionTransfer({
      transactions: new FileTransferTransactions(join(scratch, "outgoing")),
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      client: "desktop",
      call,
    })).resolves.toEqual({
      state: "recovering",
      transferId: packaged.manifest.transferId,
      stage: "persistence",
    })
    expect(call).toHaveBeenCalledOnce()
  })
})
