import { describe, expect, it } from "vitest"
import type { SessionSummary } from "@getdomovoi/protocol"

import { readOnlySessionNotice, sessionConflictOffer, sessionRecoveryOffer } from "./session-recovery.js"

const transferring: NonNullable<SessionSummary["transfer"]> = {
  phase: "transferring",
  transferId: `transfer-${"a".repeat(32)}`,
  targetMachineId: `machine-${"b".repeat(32)}`,
  intentDigest: `sha256:${"c".repeat(64)}`,
  nextGeneration: 2,
  startedAt: "2026-09-04T09:00:00.000Z",
  resumeState: "failed",
  method: "git-bundle",
  requestedBy: { client: "desktop" },
  package: { state: "staged", manifestDigest: `sha256:${"d".repeat(64)}` },
}

const session = {
  id: "session-ledger",
  state: "transferring",
  transfer: transferring,
} as unknown as SessionSummary

describe("sessionRecoveryOffer", () => {
  it("offers release only once the daemon has given the move up", () => {
    const offer = sessionRecoveryOffer(session, "studio")

    expect(offer?.transferId).toBe(transferring.transferId)
    expect(offer?.confirmation).toBe("target-does-not-have-session")
    expect(offer?.confirmLabel).toContain("studio")
    expect(offer?.detail).toContain("diverge")
  })

  it("offers release for an ordinary session, not only one that had failed", () => {
    // resumeState carries the pre-transfer session state. Gating on it meant an
    // idle session, which is the normal case, never saw the way out.
    for (const resumeState of ["idle", "done", "failed"] as const) {
      expect(sessionRecoveryOffer(
        { ...session, transfer: { ...transferring, resumeState } } as SessionSummary,
        "studio",
      )?.kind).toBe("release-stranded")
    }
  })

  it("stays quiet until the package the daemon needs is staged", () => {
    expect(sessionRecoveryOffer(
      { ...session, transfer: { ...transferring, package: { state: "preparing" } } } as SessionSummary,
      "studio",
    )).toBeUndefined()
  })

  it("does not offer release on a session that is not mid-move", () => {
    expect(sessionRecoveryOffer({ ...session, state: "idle" } as SessionSummary, "studio"))
      .toBeUndefined()
    expect(sessionRecoveryOffer({ ...session, transfer: undefined } as SessionSummary, "studio"))
      .toBeUndefined()
  })

  it("names the machine plainly when its label is unknown", () => {
    expect(sessionRecoveryOffer(session, undefined)?.confirmLabel)
      .toBe("the other machine does not have it")
  })
})

const conflict = {
  kind: "target-session-detected",
  transferId: `transfer-${"d".repeat(32)}`,
  otherMachineId: `machine-${"e".repeat(32)}`,
  otherGeneration: 4,
  detectedAt: "2026-09-04T11:00:00.000Z",
  recoveryAction: "keep-target-session",
  reason: "target-session-newer",
  manifestDigest: `sha256:${"f".repeat(64)}`,
} as NonNullable<SessionSummary["ownershipConflict"]>

const conflicted = {
  ...session,
  state: "ownership-conflict",
  ownershipConflict: conflict,
} as unknown as SessionSummary

describe("sessionConflictOffer", () => {
  it("states the whole trade before the operator confirms it", () => {
    const offer = sessionConflictOffer(conflicted, "studio")

    expect(offer?.confirmation).toBe("keep-target-session")
    expect(offer?.kind).toBe("keep-target")
    expect(offer?.transferId).toBe(conflict.transferId)
    // The three things a person must know before a one-way door: who wins, that
    // it is permanent, and that their files remain and are theirs to clean up.
    expect(offer?.detail).toContain("studio")
    expect(offer?.detail).toContain("for good")
    expect(offer?.detail).toContain("nothing removes them for you")
  })

  it("says how the conflict was found, because the two causes differ", () => {
    expect(sessionConflictOffer(conflicted, "studio")?.detail)
      .toContain("already holds a copy")
    expect(sessionConflictOffer(
      {
        ...conflicted,
        ownershipConflict: { ...conflict, kind: "recovery-contradicted" },
      } as SessionSummary,
      "studio",
    )?.detail).toContain("after it was recovered here")
  })

  it("offers nothing without a conflict to settle", () => {
    expect(sessionConflictOffer(session, "studio")).toBeUndefined()
    expect(sessionConflictOffer(
      { ...conflicted, ownershipConflict: undefined } as SessionSummary,
      "studio",
    )).toBeUndefined()
  })
})

describe("readOnlySessionNotice", () => {
  it("does not tell a moved session that cleanup will resume after a restart", () => {
    const moved = readOnlySessionNotice(
      { ...session, state: "transferred" } as SessionSummary,
      "studio",
    )

    expect(moved?.badge).toBe("Moved")
    expect(moved?.title).toBe("Moved to studio")
    expect(moved?.detail).not.toContain("Cleanup")
  })

  it("separates a release from a move and a conflict from both", () => {
    const released = readOnlySessionNotice({
      ...session,
      state: "transferred",
      transfer: {
        phase: "transferred",
        transferId: `transfer-${"a".repeat(32)}`,
        targetMachineId: `machine-${"b".repeat(32)}`,
        generation: 3,
        manifestDigest: `sha256:${"c".repeat(64)}`,
        completedAt: "2026-09-04T10:00:00.000Z",
        completion: "conflict-released",
      },
    } as unknown as SessionSummary, "studio")

    expect(released?.badge).toBe("Released")
    expect(released?.detail).toContain("gave up its claim")
    expect(readOnlySessionNotice(conflicted, "studio")?.badge).toBe("Conflict")
  })

  it("keeps the archive wording it had", () => {
    expect(readOnlySessionNotice({ ...session, state: "archived" } as SessionSummary, undefined))
      .toEqual({
        badge: "Archived",
        title: "Archived",
        detail: "This session is read-only. Its history, checkpoints, artifacts, and annotations remain available.",
      })
  })

  it("says nothing for a session that can still be worked on", () => {
    expect(readOnlySessionNotice({ ...session, state: "idle" } as SessionSummary, "studio"))
      .toBeUndefined()
  })
})
