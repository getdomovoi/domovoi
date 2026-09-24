import { z } from "zod"

import { pairingCodeSchema } from "./devices.js"
import { pairingUrlSchema } from "./pairing-url.js"
import { utf16MaxLength } from "./validation.js"

// What a pairing QR carries: the daemon's WebSocket address and a single-use
// code issued by `domovoid pair --client` for one client kind. It carries a
// code and never a credential, so the QR on a screen is spent the moment one
// device redeems it and a photograph of it afterwards opens nothing. The text
// is a fixed prefix and base64url JSON, so a scanner reading some other code
// can say it is not a Domovoi pairing code rather than try to dial it. The
// address must be TLS unless it is loopback, the same rule the daemon applies
// to its own listener, so a payload cannot talk a phone into a plaintext
// tailnet dial.
export const pairingPayloadPrefix = "domovoi-pair:1:"

// The longest text a valid payload encodes. The field bounds count UTF-16
// units; JSON escapes a control unit as six bytes and UTF-8 spends up to three
// on a unit, so the worst case is every unit of a 512-unit address and a
// 128-unit label a control character: about 5,160 characters after base64url
// and the prefix (measured, see the test). The paste field runs the decoder on
// every keystroke, so the bound is checked on the text before any base64 or
// JSON work touches it, and the encoder refuses to emit past it so the two
// sides agree on what a pairing code can be.
export const maximumPairingPayloadLength = 6144

export { pairingUrlSchema } from "./pairing-url.js"

export const pairingPayloadSchema = z.object({
  v: z.literal(1),
  url: pairingUrlSchema,
  code: pairingCodeSchema,
  label: z.string().trim().min(1).check(utf16MaxLength(128)).optional(),
}).strict()

export type PairingPayload = z.infer<typeof pairingPayloadSchema>

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(text: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("The pairing code could not be read")
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function encodePairingPayload(payload: PairingPayload): string {
  const text = `${pairingPayloadPrefix}${toBase64Url(JSON.stringify(pairingPayloadSchema.parse(payload)))}`
  if (text.length > maximumPairingPayloadLength) throw new Error("The pairing payload encodes past the envelope a scanner reads")
  return text
}

export function decodePairingPayload(text: string): PairingPayload {
  if (text.length > maximumPairingPayloadLength) throw new Error("This is too long to be a Domovoi pairing code")
  const trimmed = text.trim()
  if (!trimmed.startsWith(pairingPayloadPrefix)) throw new Error("This is not a Domovoi pairing code")
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(trimmed.slice(pairingPayloadPrefix.length)))
  } catch {
    throw new Error("The pairing code could not be read")
  }
  const result = pairingPayloadSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue?.path[0]
    throw new Error(field === "code" ? "The pairing code carries no code the machine would take" : field === "url" ? "The pairing code carries no usable daemon address" : "The pairing code is not in a shape this app reads")
  }
  return result.data
}
