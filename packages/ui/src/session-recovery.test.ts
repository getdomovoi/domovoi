import { describe, expect, it } from "vitest"
import type { SessionSummary } from "@getdomovoi/protocol"

import { readOnlySessionNotice, sessionConflictOffer, sessionRecoveryOffer, silenceFor } from "./session-recovery.js"

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

const reconciliation = {
  state: "ownership-unconfirmed",
  reason: "target-unreachable",
  firstFailedAt: "2026-09-04T09:00:00.000Z",
  lastFailedAt: "2026-09-04T11:00:00.000Z",
  attemptCount: 7,
  recoveryAction: "confirm-source-recovery",
} as const

const stranded = {
  ...session,
  transfer: {
    ...transferring,
    package: { state: "staged", manifestDigest: `sha256:${"d".repeat(64)}`, reconciliation },
  },
} as unknown as SessionSummary

const now = new Date("2026-09-04T12:00:00.000Z")

describe("sessionRecoveryOffer", () => {
  it("offers nothing until the daemon says it cannot reach the target", () => {
    // A staged package is reached by a healthy move too, so staging alone must
    // not expose a claim that the target is empty.
    for (const resumeState of ["idle", "done", "failed"] as const) {
      expect(sessionRecoveryOffer(
        { ...session, transfer: { ...transferring, resumeState } } as SessionSummary,
        "studio",
        now,
      )).toBeUndefined()
    }
  })

  it("says how long the target has been silent and how often it was tried", () => {
    const offer = sessionRecoveryOffer(stranded, "studio", now)

    expect(offer?.kind).toBe("release-stranded")
    expect(offer?.confirmation).toBe("target-does-not-have-session")
    expect(offer?.detail).toContain("studio cannot be reached")
    expect(offer?.detail).toContain("3 hours")
    expect(offer?.detail).toContain("7 attempts")
    expect(offer?.detail).toContain("diverge")
  })

  it("names each reason the daemon can report", () => {
    for (const reason of ["target-unreachable", "target-timeout", "target-pairing-required"] as const) {
      const offer = sessionRecoveryOffer({
        ...stranded,
        transfer: {
          ...transferring,
          package: {
            state: "staged",
            manifestDigest: `sha256:${"d".repeat(64)}`,
            reconciliation: { ...reconciliation, reason },
          },
        },
      } as unknown as SessionSummary, "studio", now)

      expect(offer?.detail).not.toContain("undefined")
      expect(offer?.detail.startsWith("studio ")).toBe(true)
    }
  })
})

describe("silenceFor", () => {
  it("counts in the units a person waiting would use", () => {
    const from = "2026-09-04T12:00:00.000Z"
    expect(silenceFor(from, new Date("2026-09-04T12:00:30.000Z"))).toBe("less than a minute")
    expect(silenceFor(from, new Date("2026-09-04T12:01:00.000Z"))).toBe("1 minute")
    expect(silenceFor(from, new Date("2026-09-04T12:40:00.000Z"))).toBe("40 minutes")
    expect(silenceFor(from, new Date("2026-09-04T13:00:00.000Z"))).toBe("1 hour")
    expect(silenceFor(from, new Date("2026-09-06T12:00:00.000Z"))).toBe("2 days")
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

    const contradicted = sessionConflictOffer(
      {
        ...conflicted,
        ownershipConflict: { ...conflict, kind: "recovery-contradicted" },
      } as SessionSummary,
      "studio",
    )

    // Here the person recovered the session and then worked on it, so the copy
    // left behind is their work and the notice has to say it is salvageable.
    expect(contradicted?.detail).toContain("came back holding this session")
    expect(contradicted?.detail).toContain("work done here since the recovery")
    expect(contradicted?.detail).toContain("copy across by hand")
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
