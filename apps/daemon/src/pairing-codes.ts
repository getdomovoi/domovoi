import { createHash, randomInt, timingSafeEqual } from "node:crypto"

import type { DevicePairing, DeviceRegistry } from "./device-registry.js"

export const pairingCodeTtlMs = 180_000
// A spoken code is short, so guessing is bounded rather than merely slow.
export const maximumPairingAttempts = 5

// Words chosen to be unambiguous when read aloud or written down.
const codeWords = [
  "hearth", "quiet", "ember", "willow", "harbor", "lantern", "meadow", "cedar",
  "amber", "cobalt", "falcon", "garnet", "hollow", "indigo", "juniper", "kestrel",
  "linen", "marble", "nimbus", "opal", "pebble", "quartz", "raven", "sable",
  "timber", "umber", "velvet", "walnut", "yarrow", "zephyr", "basalt", "cinder",
] as const

export class PairingCodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PairingCodeError"
  }
}

type OpenPairing = {
  digest: string
  expiresAtMs: number
  attempts: number
}

function digestOf(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

function codesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex")
  const b = Buffer.from(right, "hex")
  return a.length === b.length && timingSafeEqual(a, b)
}

export class PairingCodeService {
  #devices: DeviceRegistry
  #open: OpenPairing | undefined

  constructor(devices: DeviceRegistry) {
    this.#devices = devices
  }

  issue(nowMs: number): { code: string; expiresAt: string } {
    const words = Array.from({ length: 3 }, () => codeWords[randomInt(codeWords.length)])
    const code = `${words.join("-")}-${String(randomInt(10, 100))}`
    // Only the digest is kept, so a memory dump of the daemon does not hand
    // over a usable code, and only one pairing is ever open at a time.
    this.#open = {
      digest: digestOf(code),
      expiresAtMs: nowMs + pairingCodeTtlMs,
      attempts: 0,
    }
    return { code, expiresAt: new Date(nowMs + pairingCodeTtlMs).toISOString() }
  }

  pairingOpen(nowMs: number): boolean {
    return this.#open !== undefined && this.#open.expiresAtMs > nowMs
  }

  claim(code: string, input: { label: string }, nowMs: number): DevicePairing {
    const open = this.#open
    if (!open) throw new PairingCodeError("Pairing code is not valid")
    if (open.expiresAtMs <= nowMs) {
      this.#open = undefined
      throw new PairingCodeError("Pairing code has expired")
    }

    if (!codesMatch(open.digest, digestOf(code))) {
      open.attempts += 1
      // A wrong guess never says which part was wrong, and enough of them
      // close the pairing rather than leaving it open to be ground down.
      if (open.attempts >= maximumPairingAttempts) this.#open = undefined
      throw new PairingCodeError("Pairing code is not valid")
    }

    this.#open = undefined
    return this.#devices.pair({ label: input.label })
  }
}
