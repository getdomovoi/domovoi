import { z } from "zod"

import { credentialSchema } from "./identifiers.js"
import { utf16MaxLength } from "./validation.js"

// What a pairing QR carries: the daemon's WebSocket address and a credential
// minted for one client kind by `domovoid pair --client`. The text is a fixed
// prefix and base64url JSON, so a scanner reading some other code can say it
// is not a Domovoi pairing code rather than try to dial it. The address must
// be TLS unless it is loopback, the same rule the daemon applies to its own
// listener, so a payload cannot talk a phone into a plaintext tailnet dial.
export const pairingPayloadPrefix = "domovoi-pair:1:"

// The longest text a valid payload encodes: the prefix, then base64url of the
// JSON for a 512-character address, a 43-character credential and a
// 128-character label, is under 1,100 characters. The paste field runs the
// decoder on every keystroke, so the bound is checked on the text before any
// base64 or JSON work touches it.
export const maximumPairingPayloadLength = 2048

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"])

export const pairingUrlSchema = z.string().check(utf16MaxLength(512)).refine((value) => {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.username || url.password || url.search || url.hash) return false
  if (url.protocol === "wss:") return true
  return url.protocol === "ws:" && loopbackHosts.has(url.hostname)
}, "Pairing address must be wss://, or ws:// on loopback only")

export const pairingPayloadSchema = z.object({
  v: z.literal(1),
  url: pairingUrlSchema,
  token: credentialSchema,
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
  return `${pairingPayloadPrefix}${toBase64Url(JSON.stringify(pairingPayloadSchema.parse(payload)))}`
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
    throw new Error(field === "token" ? "The pairing code carries no valid credential" : field === "url" ? "The pairing code carries no usable daemon address" : "The pairing code is not in a shape this app reads")
  }
  return result.data
}
