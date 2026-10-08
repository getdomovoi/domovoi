import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto"

import type { ClientAccess, ClientKind } from "@getdomovoi/protocol"

import {
  DeviceLimitReachedError,
  type DeviceClaim,
  type DevicePairing,
  type DeviceRegistry,
} from "./device-registry.js"

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

// Why a spend was refused. The daemon answers the spender with one uniform
// refusal whatever this says; the reason is for the code's issuer.
export type PairingCodeRefusal = "invalid" | "expired" | "attempts-exhausted" | "wrong-kind"

export class PairingCodeError extends Error {
  readonly refusal: PairingCodeRefusal
  // The open code this refusal ended, when it ended one. A wrong guess that
  // leaves the code open names none.
  readonly closedPairingId: string | undefined

  constructor(message: string, refusal: PairingCodeRefusal = "invalid", closedPairingId?: string) {
    super(message)
    this.name = "PairingCodeError"
    this.refusal = refusal
    this.closedPairingId = closedPairingId
  }
}

// The right code was spent, but the device list had no room for its device.
export class PairingDeviceLimitError extends DeviceLimitReachedError {
  readonly pairingId: string

  constructor(pairingId: string) {
    super()
    this.name = "PairingDeviceLimitError"
    this.pairingId = pairingId
  }
}

type OpenPairing = {
  id: string
  digest: string
  expiresAtMs: number
  attempts: number
  // Set when the code was shown for one client kind. The kind travels with the
  // code rather than with the claimer, so what a code can mint is decided when
  // it is shown and cannot be talked up when it is spent.
  targetClient?: ClientKind
  clientAccess?: ClientAccess
  // Suggested name retained for a follow-up pairing payload; nothing reads it yet.
  label?: string
}

function digestOf(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

// Compared against when no code is open, so the comparison still runs. No
// presented code hashes to it: the schema refuses an empty code.
const absentDigest = digestOf("")

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

  // Issuing ends any code still open; replacedPairingId names it so its issuer
  // can be told.
  issue(nowMs: number, targetClient?: ClientKind, clientAccess?: ClientAccess, label?: string): {
    pairingId: string
    code: string
    expiresAt: string
    replacedPairingId?: string
  } {
    const words = Array.from({ length: 3 }, () => codeWords[randomInt(codeWords.length)])
    const code = `${words.join("-")}-${String(randomInt(10, 100))}`
    const replaced = this.pairingOpen(nowMs) ? this.#open?.id : undefined
    const pairingId = `pairing-${randomBytes(16).toString("hex")}`
    // Keep plaintext out of incidental inspection, but do not treat this
    // low-entropy digest as protection from an offline search. Pairing stays
    // direct-only, with online guesses bounded by maximumPairingAttempts.
    this.#open = {
      id: pairingId,
      digest: digestOf(code),
      expiresAtMs: nowMs + pairingCodeTtlMs,
      attempts: 0,
      ...(targetClient === undefined ? {} : { targetClient }),
      ...(clientAccess === undefined ? {} : { clientAccess }),
      ...(label === undefined ? {} : { label }),
    }
    return {
      pairingId,
      code,
      expiresAt: new Date(nowMs + pairingCodeTtlMs).toISOString(),
      ...(replaced === undefined ? {} : { replacedPairingId: replaced }),
    }
  }

  pairingOpen(nowMs: number): boolean {
    return this.#open !== undefined && this.#open.expiresAtMs > nowMs
  }

  // The id of the open, unexpired code this one is, or undefined. It neither
  // spends the code nor counts a guess, so it is for attributing a refusal
  // that happens before a spend, never for deciding one. The caller's answer
  // to the spender must not depend on it. It hashes and compares exactly once
  // whether the code is live, wrong, expired, spent or absent, so its own cost
  // says nothing about the code (security review r1 P3).
  matchingPairing(code: string, nowMs: number): string | undefined {
    const open = this.#open
    const live = open !== undefined && open.expiresAtMs > nowMs
    const matches = codesMatch(open?.digest ?? absentDigest, digestOf(code))
    return live && matches ? open.id : undefined
  }

  claim(code: string, input: { label: string; machineId: string; channelPublicKey?: string }, nowMs: number): DeviceClaim {
    const open = this.#spend(code, nowMs)
    // A code shown for a phone is not a machine pairing, and says only that it
    // is not valid: which kind a code was for is not worth confirming to
    // something spending codes it was not shown.
    if (open.targetClient !== undefined) throw new PairingCodeError("Pairing code is not valid", "wrong-kind", open.id)
    return this.#devices.claim(input, nowMs)
  }

  // Spending a client code is one step: the device is paired and holds its
  // credential when this returns. The kind comes from the open pairing, never
  // from the caller, and the code is spent whether or not the reply arrives.
  redeem(code: string, input: { label: string }, nowMs: number): DevicePairing & { pairingId: string } {
    const open = this.#spend(code, nowMs)
    if (open.targetClient === undefined) throw new PairingCodeError("Pairing code is not valid", "wrong-kind", open.id)
    let paired: DevicePairing
    try {
      paired = this.#devices.pair({
        // The issuer's label is kept only as a suggested name. The device's
        // own name is used (Q37 B), as the phone's "Name this phone" field
        // and the CLI's --label promise.
        label: input.label,
        binding: {
          kind: "client",
          client: open.targetClient,
          clientAccess: open.clientAccess ?? "full",
        },
      })
    } catch (error) {
      if (error instanceof DeviceLimitReachedError) throw new PairingDeviceLimitError(open.id)
      throw error
    }
    return { ...paired, pairingId: open.id }
  }

  #spend(code: string, nowMs: number): OpenPairing {
    const open = this.#open
    if (!open) throw new PairingCodeError("Pairing code is not valid")
    if (open.expiresAtMs <= nowMs) {
      this.#open = undefined
      throw new PairingCodeError("Pairing code has expired", "expired", open.id)
    }
    if (!codesMatch(open.digest, digestOf(code))) {
      open.attempts += 1
      if (open.attempts >= maximumPairingAttempts) {
        this.#open = undefined
        throw new PairingCodeError("Pairing code is not valid", "attempts-exhausted", open.id)
      }
      throw new PairingCodeError("Pairing code is not valid")
    }
    this.#open = undefined
    return open
  }
}
