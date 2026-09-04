import { describe, expect, it } from "vitest"
import type { SessionSummary } from "@getdomovoi/protocol"

import { sessionRecoveryOffer } from "./session-recovery.js"

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
  package: { state: "preparing" },
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

  it("stays out of the way while the move may still succeed", () => {
    for (const resumeState of ["idle", "done"] as const) {
      expect(sessionRecoveryOffer(
        { ...session, transfer: { ...transferring, resumeState } } as SessionSummary,
        "studio",
      )).toBeUndefined()
    }
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
