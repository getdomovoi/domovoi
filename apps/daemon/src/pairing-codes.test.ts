import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { DeviceLimitReachedError, SqliteDeviceRegistry, maximumPairedDevices } from "./device-registry.js"
import {
  PairingCodeError,
  PairingCodeService,
  PairingDeviceLimitError,
  maximumPairingAttempts,
  pairingCodeTtlMs,
} from "./pairing-codes.js"

const machineId = `machine-${"a".repeat(32)}`
const claimant = { label: "studio-ipad", machineId }

function service(options: { now?: number } = {}) {
  const devices = new SqliteDeviceRegistry(new DatabaseSync(":memory:"))
  const pairing = new PairingCodeService(devices)
  return { pairing, devices, start: options.now ?? 1_000 }
}

describe("PairingCodeService", () => {
  it("issues a code a person can read aloud", () => {
    const { pairing, start } = service()

    const issued = pairing.issue(start)

    expect(issued.code).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/)
    expect(issued.expiresAt).toBe(new Date(start + pairingCodeTtlMs).toISOString())
  })

  it("spends the code without activating a credential before durable source confirmation", () => {
    const { pairing, devices, start } = service()
    const issued = pairing.issue(start)

    const paired = pairing.claim(issued.code, claimant, start + 1_000)

    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(devices.verify(paired.token)).toBeUndefined()
    expect(devices.isActive(paired.token)).toBe(false)
    expect(devices.list()).toEqual([])
  })

  it("does not revoke working machine authority for an abandoned re-pair claim", () => {
    const { pairing, devices, start } = service()
    const existing = devices.pair({ label: "working source", binding: { kind: "machine", machineId } })
    const issued = pairing.issue(start)
    pairing.claim(issued.code, claimant, start + 1_000)

    expect(devices.isActive(existing.token)).toBe(true)
    expect(devices.list()).toEqual([existing.device])
  })

  it("binds client access to the code that grants the credential", () => {
    const { pairing, devices, start } = service()
    const issued = pairing.issue(start, "phone", "watching")
    const paired = pairing.redeem(issued.code, { label: "display" }, start)

    expect(devices.verify(paired.token)?.binding).toEqual({
      kind: "client", client: "phone", clientAccess: "watching",
    })
  })

  it("names the paired device by its own name even when the issuer suggested one", () => {
    const { pairing, devices, start } = service()
    const issued = pairing.issue(start, "web", undefined, "Studio browser")
    const paired = pairing.redeem(issued.code, { label: "Firefox on Linux" }, start)

    // The phone's "Name this phone" field and the CLI's --label promise the
    // device names itself (Q37 B). The issuer's label is only a suggestion.
    expect(paired.device.label).toBe("Firefox on Linux")
    expect(devices.list().map((device) => device.label)).toEqual(["Firefox on Linux"])
  })

  it("names the paired device with its own label when the issuer gave none", () => {
    const { pairing, start } = service()
    const issued = pairing.issue(start, "phone")
    expect(pairing.redeem(issued.code, { label: "iPhone" }, start).device.label).toBe("iPhone")
  })

  it("spends a code on the first successful pairing", () => {
    const { pairing, start } = service()
    const issued = pairing.issue(start)
    pairing.claim(issued.code, claimant, start)

    expect(() => pairing.claim(issued.code, { label: "second-ipad", machineId }, start))
      .toThrow(PairingCodeError)
  })

  it("refuses a code that has expired", () => {
    const { pairing, start } = service()
    const issued = pairing.issue(start)

    expect(() => pairing.claim(issued.code, claimant, start + pairingCodeTtlMs + 1))
      .toThrow("Pairing code has expired")
  })

  it("refuses a code that was never issued", () => {
    const { pairing, start } = service()
    pairing.issue(start)

    expect(() => pairing.claim("wrong-wrong-wrong-11", claimant, start))
      .toThrow("Pairing code is not valid")
  })

  it("burns the code after too many wrong guesses", () => {
    const { pairing, start } = service()
    const issued = pairing.issue(start)

    for (let attempt = 0; attempt < maximumPairingAttempts; attempt += 1) {
      expect(() => pairing.claim("wrong-wrong-wrong-11", { label: "guess", machineId }, start))
        .toThrow(PairingCodeError)
    }

    expect(() => pairing.claim(issued.code, claimant, start))
      .toThrow("Pairing code is not valid")
  })

  it("keeps only the most recently issued code", () => {
    const { pairing, start } = service()
    const first = pairing.issue(start)
    const second = pairing.issue(start + 1)

    expect(() => pairing.claim(first.code, claimant, start + 2))
      .toThrow("Pairing code is not valid")
    expect(pairing.claim(second.code, claimant, start + 2).token)
      .toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("reports whether pairing is open, so a machine can show it is waiting", () => {
    const { pairing, start } = service()
    expect(pairing.pairingOpen(start)).toBe(false)

    const issued = pairing.issue(start)
    expect(pairing.pairingOpen(start)).toBe(true)
    expect(pairing.pairingOpen(start + pairingCodeTtlMs + 1)).toBe(false)

    pairing.claim(issued.code, claimant, start)
    expect(pairing.pairingOpen(start)).toBe(false)
  })

  it("issues a different code every time", () => {
    const { pairing, start } = service()
    const codes = new Set(Array.from({ length: 20 }, (_unused, index) => pairing.issue(start + index).code))

    expect(codes.size).toBeGreaterThan(1)
  })

  it("names each code, and says which open code a new one replaced", () => {
    const { pairing, start } = service()
    const first = pairing.issue(start, "phone")
    expect(first.pairingId).toMatch(/^pairing-[0-9a-f]{32}$/)
    expect(first).not.toHaveProperty("replacedPairingId")

    const second = pairing.issue(start + 1, "phone")
    expect(second.pairingId).not.toBe(first.pairingId)
    expect(second.replacedPairingId).toBe(first.pairingId)

    // A code that already ran out its time was not open, so nothing was replaced.
    const third = pairing.issue(start + 2 + pairingCodeTtlMs, "phone")
    expect(third).not.toHaveProperty("replacedPairingId")
  })

  it("says which open code a presented code matches, without spending it or counting a guess", () => {
    const { pairing, start } = service()
    const issued = pairing.issue(start, "phone")

    for (let attempt = 0; attempt < maximumPairingAttempts + 1; attempt += 1) {
      expect(pairing.matchingPairing("wrong-wrong-wrong-11", start)).toBeUndefined()
    }
    expect(pairing.matchingPairing(issued.code, start)).toBe(issued.pairingId)
    expect(pairing.matchingPairing(issued.code, start + pairingCodeTtlMs)).toBeUndefined()
    // Neither the matches nor the misses spent the code or used up its attempts.
    expect(pairing.redeem(issued.code, { label: "phone" }, start).pairingId).toBe(issued.pairingId)
    expect(pairing.matchingPairing(issued.code, start)).toBeUndefined()
  })

  it("names the code a refusal closed, and why", () => {
    const refusal = (spend: () => unknown) => {
      try {
        spend()
      } catch (error) {
        if (error instanceof PairingCodeError) return { refusal: error.refusal, closedPairingId: error.closedPairingId }
        throw error
      }
      throw new Error("expected a refusal")
    }
    const { pairing, start } = service()

    const guessed = pairing.issue(start, "phone")
    for (let attempt = 1; attempt < maximumPairingAttempts; attempt += 1) {
      expect(refusal(() => pairing.redeem("wrong-wrong-wrong-11", { label: "guess" }, start)))
        .toEqual({ refusal: "invalid", closedPairingId: undefined })
    }
    expect(refusal(() => pairing.redeem("wrong-wrong-wrong-11", { label: "guess" }, start)))
      .toEqual({ refusal: "attempts-exhausted", closedPairingId: guessed.pairingId })
    expect(refusal(() => pairing.redeem(guessed.code, { label: "late" }, start)))
      .toEqual({ refusal: "invalid", closedPairingId: undefined })

    const phoneCode = pairing.issue(start, "phone")
    expect(refusal(() => pairing.claim(phoneCode.code, claimant, start)))
      .toEqual({ refusal: "wrong-kind", closedPairingId: phoneCode.pairingId })

    const machineCode = pairing.issue(start)
    expect(refusal(() => pairing.redeem(machineCode.code, { label: "phone" }, start)))
      .toEqual({ refusal: "wrong-kind", closedPairingId: machineCode.pairingId })

    const expired = pairing.issue(start, "phone")
    expect(refusal(() => pairing.redeem(expired.code, { label: "phone" }, start + pairingCodeTtlMs)))
      .toEqual({ refusal: "expired", closedPairingId: expired.pairingId })
  })

  it("names the spent code when the paired device list is full", () => {
    const { pairing, devices, start } = service()
    for (let index = 0; index < maximumPairedDevices; index += 1) {
      devices.pair({ label: `device ${index}`, binding: { kind: "client", client: "web", clientAccess: "full" } })
    }
    const issued = pairing.issue(start, "phone")
    let failure: unknown
    try {
      pairing.redeem(issued.code, { label: "one too many" }, start)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(DeviceLimitReachedError)
    expect(failure).toBeInstanceOf(PairingDeviceLimitError)
    expect((failure as PairingDeviceLimitError).pairingId).toBe(issued.pairingId)
    // The code was spent on the way to the full list.
    expect(pairing.pairingOpen(start)).toBe(false)
  })

  it("never puts the code in the error it reports", () => {
    const { pairing, start } = service()
    const issued = pairing.issue(start)

    const failure = (() => {
      try {
        pairing.claim("wrong-wrong-wrong-11", { label: "guess", machineId }, start)
        return undefined
      } catch (error) {
        return error as Error
      }
    })()

    expect(String(failure)).not.toContain(issued.code)
  })
})
