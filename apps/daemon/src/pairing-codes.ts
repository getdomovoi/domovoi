import { createHash, randomInt, timingSafeEqual } from "node:crypto"

import type { ClientKind } from "@getdomovoi/protocol"

import type { DeviceClaim, DevicePairing, DeviceRegistry } from "./device-registry.js"

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
  // Set when the code was shown for one client kind. The kind travels with the
  // code rather than with the claimer, so what a code can mint is decided when
  // it is shown and cannot be talked up when it is spent.
  targetClient?: ClientKind
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

  issue(nowMs: number, targetClient?: ClientKind): { code: string; expiresAt: string } {
    const words = Array.from({ length: 3 }, () => codeWords[randomInt(codeWords.length)])
    const code = `${words.join("-")}-${String(randomInt(10, 100))}`
    // Keep plaintext out of incidental inspection, but do not treat this
    // low-entropy digest as protection from an offline search. Pairing stays
    // direct-only, with online guesses bounded by maximumPairingAttempts.
    this.#open = {
      digest: digestOf(code),
      expiresAtMs: nowMs + pairingCodeTtlMs,
      attempts: 0,
      ...(targetClient === undefined ? {} : { targetClient }),
    }
    return { code, expiresAt: new Date(nowMs + pairingCodeTtlMs).toISOString() }
  }

  pairingOpen(nowMs: number): boolean {
    return this.#open !== undefined && this.#open.expiresAtMs > nowMs
  }

  claim(code: string, input: { label: string; machineId: string; channelPublicKey?: string }, nowMs: number): DeviceClaim {
    const open = this.#spend(code, nowMs)
    // A code shown for a phone is not a machine pairing, and says only that it
    // is not valid: which kind a code was for is not worth confirming to
    // something spending codes it was not shown.
    if (open.targetClient !== undefined) throw new PairingCodeError("Pairing code is not valid")
    return this.#devices.claim(input, nowMs)
  }

  // Spending a client code is one step: the device is paired and holds its
  // credential when this returns. The kind comes from the open pairing, never
  // from the caller, and the code is spent whether or not the reply arrives.
  redeem(code: string, input: { label: string }, nowMs: number): DevicePairing {
    const open = this.#spend(code, nowMs)
    if (open.targetClient === undefined) throw new PairingCodeError("Pairing code is not valid")
    return this.#devices.pair({ label: input.label, binding: { kind: "client", client: open.targetClient } })
  }

  #spend(code: string, nowMs: number): OpenPairing {
    const open = this.#open
    if (!open) throw new PairingCodeError("Pairing code is not valid")
    if (open.expiresAtMs <= nowMs) {
      this.#open = undefined
      throw new PairingCodeError("Pairing code has expired")
    }
    if (!codesMatch(open.digest, digestOf(code))) {
      open.attempts += 1
      if (open.attempts >= maximumPairingAttempts) this.#open = undefined
      throw new PairingCodeError("Pairing code is not valid")
    }
    this.#open = undefined
    return open
  }
}
