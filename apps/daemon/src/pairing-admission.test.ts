import { describe, expect, it } from "vitest"

import {
  maximumPairingClaimsPerListener,
  maximumPairingClaimsPerSource,
  PairingClaimAdmission,
  pairingClaimWindowMs,
} from "./pairing-admission.js"

describe("PairingClaimAdmission", () => {
  it("caps each source at three claims in a rolling minute", () => {
    const admission = new PairingClaimAdmission()
    expect(maximumPairingClaimsPerSource).toBe(3)
    expect(pairingClaimWindowMs).toBe(60_000)
    for (const now of [0, 10, 20]) expect(admission.admit("192.0.2.1", now)).toBe(true)
    expect(admission.admit("192.0.2.1", 59_999)).toBe(false)
    expect(admission.admit("192.0.2.1", 60_000)).toBe(true)
    expect(admission.admit("192.0.2.1", 60_000)).toBe(false)
    expect(admission.admit("192.0.2.1", 60_010)).toBe(true)
    expect(admission.admit("192.0.2.1", 60_010)).toBe(false)
  })

  it("caps all sources together at thirty and refuses source churn until budget returns", () => {
    const admission = new PairingClaimAdmission()
    expect(maximumPairingClaimsPerListener).toBe(30)
    for (let index = 0; index < 30; index += 1) {
      expect(admission.admit(`source-${index}`, index)).toBe(true)
    }
    for (let index = 30; index < 1_000; index += 1) {
      expect(admission.admit(`source-${index}`, 59_999)).toBe(false)
    }
    expect(admission.admit("new-source", 60_000)).toBe(true)
    expect(admission.admit("another-source", 60_000)).toBe(false)
    expect(admission.admit("another-source", 60_001)).toBe(true)
  })

  it("does not let one exhausted source spend the rest of the listener budget", () => {
    const admission = new PairingClaimAdmission()
    for (let index = 0; index < 100; index += 1) {
      expect(admission.admit("attacker", 0)).toBe(index < 3)
    }
    expect(admission.admit("other-peer", 0)).toBe(true)
  })

  it("does not extend cooldown when a refused peer keeps trying", () => {
    const admission = new PairingClaimAdmission()
    for (let index = 0; index < 3; index += 1) expect(admission.admit("peer", 0)).toBe(true)
    for (const now of [10_000, 30_000, 59_999]) expect(admission.admit("peer", now)).toBe(false)
    expect(admission.admit("peer", 60_000)).toBe(true)
  })

  it("refuses missing sources and invalid clocks without refilling on clock reversal", () => {
    const admission = new PairingClaimAdmission()
    expect(admission.admit(undefined, 0)).toBe(false)
    expect(admission.admit("", 0)).toBe(false)
    expect(admission.admit("peer", Number.NaN)).toBe(false)
    expect(admission.admit("peer", Number.POSITIVE_INFINITY)).toBe(false)
    for (let index = 0; index < 3; index += 1) expect(admission.admit("peer", 100)).toBe(true)
    expect(admission.admit("peer", 0)).toBe(false)
    expect(admission.admit("peer", 60_099)).toBe(false)
    expect(admission.admit("peer", 60_100)).toBe(true)
  })
})
