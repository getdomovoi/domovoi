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
  clearSourceTransferReconciliation,
  clearConfirmedSourceRecovery,
  completeSourceSessionTransfer,
  freezeSourceSessionTransfer,
  markSourceTransferReconciliationFailure,
  markSourceOwnershipConflict,
  markTargetSessionOwnershipConflict,
  recoverUnconfirmedSourceTransfer,
  releaseSourceOwnershipConflict,
  sendPreparedSessionTransfer,
  stageOutgoingSessionTransferPackage,
  stageSourceSessionCheckpoint,
  thawSourceSessionTransfer,
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
      { client: "desktop", clientId: "studio-mac" },
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
        method: "git-bundle",
        requestedBy: { client: "desktop", clientId: "studio-mac" },
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

  it("restores the exact settled state after an authoritative refusal", async () => {
    const { source, intent, packaged } = await transferFixture()
    source.sessions[0]!.state = "failed"
    const frozen = freezeSourceSessionTransfer(
      source,
      intent,
      packaged.manifest.transferId,
      "2026-09-03T22:00:00.000Z",
      { client: "desktop" },
    )
    const staged = stageSourceSessionCheckpoint(frozen, packaged.manifest)

    const thawed = thawSourceSessionTransfer(
      staged,
      packaged.manifest.transferId,
      "2026-09-03T22:01:00.000Z",
    )

    expect(thawed.sessions[0]).toMatchObject({
      state: "failed",
      baseCommit: checkpointCommit,
    })
    expect(thawed.sessions[0]).not.toHaveProperty("transfer")
  })

  it("records target reconciliation evidence until an authoritative response arrives", async () => {
    const { source, intent, packaged } = await transferFixture()
    const staged = stageSourceSessionCheckpoint(
      freezeSourceSessionTransfer(
        source,
        intent,
        packaged.manifest.transferId,
        "2026-09-03T22:00:00.000Z",
        { client: "desktop" },
      ),
      packaged.manifest,
    )

    const first = markSourceTransferReconciliationFailure(staged, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      reason: "target-unreachable",
      failedAt: "2026-09-03T22:01:00.000Z",
    })
    expect(first.sessions[0]?.transfer).toMatchObject({
      package: {
        state: "staged",
        reconciliation: {
          state: "ownership-unconfirmed",
          reason: "target-unreachable",
          firstFailedAt: "2026-09-03T22:01:00.000Z",
          lastFailedAt: "2026-09-03T22:01:00.000Z",
          attemptCount: 1,
          recoveryAction: "confirm-source-recovery",
        },
      },
    })

    const second = markSourceTransferReconciliationFailure(first, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      reason: "target-timeout",
      failedAt: "2026-09-03T22:02:00.000Z",
    })
    expect(second.sessions[0]?.transfer).toMatchObject({
      package: {
        reconciliation: {
          reason: "target-timeout",
          firstFailedAt: "2026-09-03T22:01:00.000Z",
          lastFailedAt: "2026-09-03T22:02:00.000Z",
          attemptCount: 2,
        },
      },
    })

    const cleared = clearSourceTransferReconciliation(second, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
    })
    expect(cleared.sessions[0]?.transfer).not.toHaveProperty("package.reconciliation")
  })

  it("refuses source recovery without durable reconciliation evidence", async () => {
    const { source, intent, packaged } = await transferFixture()
    const staged = stageSourceSessionCheckpoint(
      freezeSourceSessionTransfer(
        source,
        intent,
        packaged.manifest.transferId,
        "2026-09-03T22:00:00.000Z",
        { client: "desktop" },
      ),
      packaged.manifest,
    )

    expect(() => recoverUnconfirmedSourceTransfer(staged, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      client: "desktop",
      recoveredAt: "2026-09-03T22:02:00.000Z",
    })).toThrow("session-state-changed")
  })

  it("retains who reclaimed an unverifiable source and freezes that source on later conflict", async () => {
    const { source, intent, packaged } = await transferFixture()
    const staged = stageSourceSessionCheckpoint(
      freezeSourceSessionTransfer(
        source,
        intent,
        packaged.manifest.transferId,
        "2026-09-03T22:00:00.000Z",
        { client: "desktop" },
      ),
      packaged.manifest,
    )
    const recoverable = markSourceTransferReconciliationFailure(staged, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      reason: "target-unreachable",
      failedAt: "2026-09-03T22:01:00.000Z",
    })
    const recovered = recoverUnconfirmedSourceTransfer(recoverable, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      client: "desktop",
      clientId: "studio-mac",
      recoveredAt: "2026-09-03T22:02:00.000Z",
    })
    expect(recovered.sessions[0]).toMatchObject({
      state: "idle",
      sourceRecovery: {
        transferId: packaged.manifest.transferId,
        targetMachineId,
        generation: 4,
        manifestDigest: packaged.manifestDigest,
        decidedBy: { client: "desktop", clientId: "studio-mac" },
      },
    })
    expect(recovered.thread.at(-1)).toMatchObject({
      kind: "system",
      body: "Source ownership recovered without target confirmation.",
    })

    const conflicted = markSourceOwnershipConflict(recovered, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      otherMachineId: targetMachineId,
      otherGeneration: 5,
      detectedAt: "2026-09-03T23:00:00.000Z",
    })
    expect(conflicted.sessions[0]).toMatchObject({
      state: "ownership-conflict",
      ownershipConflict: {
        kind: "recovery-contradicted",
        recoveryAction: "keep-target-session",
        otherGeneration: 5,
      },
    })
    expect(conflicted.thread.at(-1)).toMatchObject({
      kind: "system",
      body: "Session ownership conflict detected.",
    })

    const released = releaseSourceOwnershipConflict(conflicted, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      client: "desktop",
      clientId: "studio-mac",
      releasedAt: "2026-09-03T23:05:00.000Z",
    })
    expect(released.sessions[0]).toMatchObject({
      state: "transferred",
      workspacePath: "/source/session",
      ownershipGeneration: 5,
      runtime: { auto: false },
      transfer: {
        phase: "transferred",
        completion: "conflict-released",
        transferId: packaged.manifest.transferId,
        targetMachineId,
        generation: 5,
        manifestDigest: packaged.manifestDigest,
      },
    })
    expect(released.sessions[0]).not.toHaveProperty("sourceRecovery")
    expect(released.sessions[0]).not.toHaveProperty("ownershipConflict")
    expect(released.thread.at(-1)).toMatchObject({
      kind: "system",
      body: "Source ownership released to the target session.",
      detail: expect.stringContaining("studio-mac"),
    })
  })

  it("freezes direct target ownership evidence without pretending a person recovered it", async () => {
    const { source, intent, packaged } = await transferFixture()
    const staged = stageSourceSessionCheckpoint(
      freezeSourceSessionTransfer(
        source,
        intent,
        packaged.manifest.transferId,
        "2026-09-03T22:00:00.000Z",
        { client: "desktop" },
      ),
      packaged.manifest,
    )

    const conflicted = markTargetSessionOwnershipConflict(staged, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      reason: "target-session-newer",
      otherGeneration: 6,
      detectedAt: "2026-09-03T22:01:00.000Z",
    })

    expect(conflicted.sessions[0]).toMatchObject({
      state: "ownership-conflict",
      ownershipGeneration: 4,
      workspacePath: "/source/session",
      ownershipConflict: {
        kind: "target-session-detected",
        reason: "target-session-newer",
        transferId: packaged.manifest.transferId,
        otherMachineId: targetMachineId,
        otherGeneration: 6,
        manifestDigest: packaged.manifestDigest,
        recoveryAction: "keep-target-session",
      },
    })
    expect(conflicted.sessions[0]).not.toHaveProperty("transfer")
    expect(conflicted.sessions[0]).not.toHaveProperty("sourceRecovery")
    expect(conflicted.sessions[0]).not.toHaveProperty("providerThreadId")
  })

  it("clears a recovery claim only after its target confirms no ownership", async () => {
    const { source, intent, packaged } = await transferFixture()
    const staged = stageSourceSessionCheckpoint(
      freezeSourceSessionTransfer(
        source,
        intent,
        packaged.manifest.transferId,
        "2026-09-03T22:00:00.000Z",
        { client: "desktop" },
      ),
      packaged.manifest,
    )
    const recoverable = markSourceTransferReconciliationFailure(staged, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      reason: "target-unreachable",
      failedAt: "2026-09-03T22:01:00.000Z",
    })
    const recovered = recoverUnconfirmedSourceTransfer(recoverable, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      client: "desktop",
      recoveredAt: "2026-09-03T22:02:00.000Z",
    })

    const cleared = clearConfirmedSourceRecovery(recovered, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      targetMachineId,
      confirmedAt: "2026-09-03T23:00:00.000Z",
    })

    expect(cleared.sessions[0]).not.toHaveProperty("sourceRecovery")
    expect(cleared.thread.at(-1)).toMatchObject({
      kind: "system",
      body: "Target confirmed it does not own this session.",
    })
    expect(() => clearConfirmedSourceRecovery(recovered, {
      sessionId: packaged.manifest.sessionId,
      transferId: packaged.manifest.transferId,
      targetMachineId: `machine-${"0".repeat(32)}`,
      confirmedAt: "2026-09-03T23:00:00.000Z",
    })).toThrow("session-state-changed")
  })
})

describe("prepared source transfer delivery", () => {
  it("never trusts a target response for another transfer", async () => {
    const { packaged } = await transferFixture()
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-outgoing-correlation-"))
    scratchDirectories.push(scratch)
    const outgoing = new FileTransferTransactions(join(scratch, "outgoing"))
    await stageOutgoingSessionTransferPackage(outgoing, packaged)
    const wrongTransferId = `transfer-${"0".repeat(32)}`
    const send = (call: (method: string) => Promise<unknown>) => sendPreparedSessionTransfer({
      transactions: outgoing,
      transferId: packaged.manifest.transferId,
      manifestDigest: packaged.manifestDigest,
      initiatedByClient: "desktop",
      call,
    })

    await expect(send(async () => ({ state: "aborted", transferId: wrongTransferId })))
      .resolves.toEqual({ state: "unknown", transferId: packaged.manifest.transferId })
    await expect(send(async (method) => method === "transfer.status"
      ? { state: "unknown", transferId: packaged.manifest.transferId }
      : { state: "refused", transferId: wrongTransferId, reason: "session-state-changed" }))
      .rejects.toThrow("Target transfer identity changed")
    await expect(send(async (method) => {
      if (method === "transfer.status") {
        return { state: "unknown", transferId: packaged.manifest.transferId }
      }
      if (method === "transfer.prepare") {
        return {
          state: "receiving",
          transferId: packaged.manifest.transferId,
          missingMemberIds: [packaged.manifest.stateMemberId],
        }
      }
      return { state: "refused", transferId: wrongTransferId, reason: "digest-mismatch" }
    })).rejects.toThrow("Target transfer identity changed")
    await expect(send(async (method) => {
      if (method === "transfer.status") {
        return { state: "unknown", transferId: packaged.manifest.transferId }
      }
      if (method === "transfer.prepare") {
        return { state: "prepared", transferId: packaged.manifest.transferId }
      }
      return { state: "refused", transferId: wrongTransferId, reason: "session-state-changed" }
    })).rejects.toThrow("Target transfer identity changed")
  })

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
      initiatedByClient: "desktop",
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
      initiatedByClient: "desktop",
      call,
    })).resolves.toEqual({
      state: "recovering",
      transferId: packaged.manifest.transferId,
      stage: "persistence",
    })
    expect(call).toHaveBeenCalledOnce()
  })
})
