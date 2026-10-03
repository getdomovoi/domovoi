import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PairingIssuerSlot } from "./pairing-issuer.js"

// Ruling Q354 A holds one issuing connection per open client code. Security
// review r1 note: it must not outlive the connection or the code.

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const ttlMs = 180_000

describe("PairingIssuerSlot", () => {
  it("hands the issuer out for its own code only, and once for an ending outcome", () => {
    const slot = new PairingIssuerSlot<string>()
    slot.set("pairing-a", "socket-a", ttlMs)
    expect(slot.issuer("pairing-b", false)).toBeUndefined()
    expect(slot.issuer("pairing-a", false)).toBe("socket-a")
    expect(slot.issuer("pairing-a", true)).toBe("socket-a")
    expect(slot.issuer("pairing-a", false)).toBeUndefined()
  })

  it("forgets the issuer when its code runs out its time", () => {
    const slot = new PairingIssuerSlot<string>()
    slot.set("pairing-a", "socket-a", ttlMs)
    vi.advanceTimersByTime(ttlMs - 1)
    expect(slot.current).toBe("pairing-a")
    vi.advanceTimersByTime(1)
    expect(slot.current).toBeUndefined()
  })

  it("forgets the issuer when its connection closes, and no other", () => {
    const slot = new PairingIssuerSlot<string>()
    slot.set("pairing-a", "socket-a", ttlMs)
    slot.forget("socket-b")
    expect(slot.current).toBe("pairing-a")
    slot.forget("socket-a")
    expect(slot.current).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("lets a new code's expiry timer replace the old one, and clears on stop", () => {
    const slot = new PairingIssuerSlot<string>()
    slot.set("pairing-a", "socket-a", ttlMs)
    vi.advanceTimersByTime(ttlMs - 10)
    slot.set("pairing-b", "socket-b", ttlMs)
    vi.advanceTimersByTime(10)
    expect(slot.current).toBe("pairing-b")
    expect(vi.getTimerCount()).toBe(1)
    slot.clear()
    expect(slot.current).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
