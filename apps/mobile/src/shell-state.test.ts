import { describe, expect, it } from "vitest"

import type { ConnectionFault } from "./lib/connection-fault"
import { shellState, unreachableShell } from "./shell-state"

const base = {
  restoringCredential: false,
  hasCredential: true,
  hasSnapshot: false,
  fault: undefined as ConnectionFault | undefined,
}

describe("shellState", () => {
  it("draws daemon data only once a snapshot has arrived", () => {
    expect(shellState({ ...base, hasSnapshot: true }).kind).toBe("ready")
  })

  it("keeps a snapshot on screen even while the credential is being restored", () => {
    expect(shellState({ ...base, hasSnapshot: true, restoringCredential: true }).kind).toBe("ready")
  })

  it("tells apart a phone that has not looked yet from one with no pairing", () => {
    expect(shellState({ ...base, restoringCredential: true, hasCredential: false }).kind)
      .toBe("restoring")
    expect(shellState({ ...base, hasCredential: false }).kind).toBe("unpaired")
  })

  it("says a refused credential is refused rather than still reaching", () => {
    const refused = shellState({
      ...base,
      fault: { retriable: false, headline: "The daemon refused this credential", detail: "Pair again." },
    })

    expect(refused.kind).toBe("refused")
    expect(refused.detail).toBe("Pair again.")
  })

  it("never claims the workspace is empty when it has never been told what is in it", () => {
    const reaching = shellState(base)

    expect(reaching.kind).toBe("reaching")
    expect(reaching.detail).toContain("Nothing has been received")
  })

  it("carries a transient fault's own words while it keeps trying", () => {
    const reaching = shellState({
      ...base,
      fault: { retriable: true, headline: "Cannot reach the daemon", detail: "Cannot reach ws://desk" },
    })

    expect(reaching.kind).toBe("reaching")
    expect(reaching.detail).toBe("Cannot reach ws://desk")
  })
})

// Two screens once answered "no daemon named": the notice and, per tab, the
// unpaired screens. This is what stops both of them being drawable for it.
describe("unreachableShell", () => {
  it("refuses a phone that has never been given a daemon", () => {
    const shell = shellState({
      restoringCredential: false,
      hasCredential: false,
      hasSnapshot: false,
      fault: undefined,
    })
    expect(shell.kind).toBe("unpaired")
    expect(unreachableShell(shell)).toBeUndefined()
  })

  it("refuses a workspace that is already drawn", () => {
    const shell = shellState({
      restoringCredential: false,
      hasCredential: true,
      hasSnapshot: true,
      fault: undefined,
    })
    expect(unreachableShell(shell)).toBeUndefined()
  })

  it("hands back a daemon that is in hand and will not answer", () => {
    const shell = shellState({
      restoringCredential: false,
      hasCredential: true,
      hasSnapshot: false,
      fault: { retriable: true, headline: "Cannot reach the daemon", detail: "No route." },
    })
    expect(unreachableShell(shell)).toEqual({
      kind: "reaching",
      headline: "Reaching the daemon",
      detail: "No route.",
    })
  })
})
