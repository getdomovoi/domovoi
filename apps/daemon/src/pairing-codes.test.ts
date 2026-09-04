import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { SqliteDeviceRegistry } from "./device-registry.js"
import {
  PairingCodeError,
  PairingCodeService,
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

  it("pairs a device when the code matches", () => {
    const { pairing, devices, start } = service()
    const issued = pairing.issue(start)

    const paired = pairing.claim(issued.code, claimant, start + 1_000)

    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(devices.verify(paired.token)).toEqual({
      device: expect.objectContaining({ label: "studio-ipad" }),
      binding: { kind: "machine", machineId },
    })
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
