import { describe, expect, it } from "vitest"

import { demoWorkspace } from "./fixtures.js"
import type { SessionSummary } from "./schema.js"
import {
  sourcePreflight,
  transferReceiptSchema,
} from "./transfer.js"

const session: SessionSummary = {
  ...demoWorkspace.sessions[0]!,
  state: "idle",
  workspacePath: "/home/tester/.domovoi/worktrees/session-1",
  baseCommit: "b".repeat(40),
}
delete (session as { activeTurnId?: string }).activeTurnId

const sourceMachineId = `machine-${"a".repeat(32)}`
const targetMachineId = `machine-${"b".repeat(32)}`

describe("sourcePreflight", () => {
  it("allows a settled session with a worktree to move", () => {
    expect(sourcePreflight({ session })).toEqual({ allowed: true })
  })

  it("refuses while the session is mid-turn, so work is never moved under an agent", () => {
    expect(sourcePreflight({ session: { ...session, state: "active", activeTurnId: "turn-1" } }))
      .toEqual({ allowed: false, reason: "session-turn-active" })
  })

  it("refuses an archived session", () => {
    for (const state of ["archiving", "archived"] as const) {
      expect(sourcePreflight({ session: { ...session, state } }))
        .toEqual({ allowed: false, reason: "session-archived" })
    }
  })

  it("refuses a session with no isolated worktree to send", () => {
    const { workspacePath: _path, ...withoutWorktree } = session
    expect(sourcePreflight({ session: withoutWorktree as SessionSummary }))
      .toEqual({ allowed: false, reason: "session-has-no-worktree" })
  })

  it("refuses to move an owner recovered without target confirmation", () => {
    expect(sourcePreflight({
      session: {
        ...session,
        sourceRecovery: {
          transferId: `transfer-${"c".repeat(32)}`,
          targetMachineId,
          generation: session.ownershipGeneration ?? 0,
          manifestDigest: `sha256:${"d".repeat(64)}`,
          recoveredAt: "2026-09-03T22:00:00.000Z",
          decidedBy: { client: "desktop" },
        },
      },
    })).toEqual({ allowed: false, reason: "session-recovery-unresolved" })
  })
})

describe("transferReceiptSchema", () => {
  const receipt = {
    sessionId: session.id,
    sourceMachineId,
    targetMachineId,
    method: "git-bundle" as const,
    checkpointId: "checkpoint-1",
    checkpointCommit: "c".repeat(40),
    recoveryCheckpointRetained: true as const,
    outcome: "succeeded" as const,
    decidedBy: { client: "desktop" as const },
    startedAt: "2026-08-31T12:00:00.000Z",
    completedAt: "2026-08-31T12:00:30.000Z",
  }

  it("records what moved, where, and who asked", () => {
    expect(transferReceiptSchema.parse(receipt)).toEqual(receipt)
  })

  it("cannot record a transfer that dropped the source recovery checkpoint", () => {
    expect(transferReceiptSchema.safeParse({ ...receipt, recoveryCheckpointRetained: false }).success)
      .toBe(false)
  })

  it("records a refusal with its reason", () => {
    const refused = {
      ...receipt,
      outcome: "refused" as const,
      reason: "target-unreachable" as const,
    }
    expect(transferReceiptSchema.parse(refused).reason).toBe("target-unreachable")
    expect(transferReceiptSchema.safeParse({
      ...refused,
      reason: "session-state-changed",
    }).success).toBe(true)
  })

  it("couples every receipt outcome to an honest reason", () => {
    expect(transferReceiptSchema.safeParse({
      ...receipt,
      reason: "target-unreachable",
    }).success).toBe(false)
    expect(transferReceiptSchema.safeParse({
      ...receipt,
      outcome: "refused",
    }).success).toBe(false)
    expect(transferReceiptSchema.safeParse({
      ...receipt,
      outcome: "failed",
    }).success).toBe(false)
  })

  it("records who knowingly reclaimed a source without target confirmation", () => {
    const recovered = {
      ...receipt,
      outcome: "source-recovered" as const,
      reason: "target-ownership-unconfirmed" as const,
      decidedBy: { client: "desktop" as const, clientId: "studio-mac" },
    }
    expect(transferReceiptSchema.parse(recovered)).toEqual(recovered)
    expect(transferReceiptSchema.safeParse({
      ...recovered,
      reason: undefined,
    }).success).toBe(false)
    expect(transferReceiptSchema.safeParse({
      ...receipt,
      reason: "target-ownership-unconfirmed",
    }).success).toBe(false)
  })

  it("rejects a checkpoint commit that is not a full object name", () => {
    expect(transferReceiptSchema.safeParse({ ...receipt, checkpointCommit: "c0ffee" }).success)
      .toBe(false)
  })
})
