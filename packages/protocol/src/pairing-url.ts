import { z } from "zod"

import { utf16MaxLength } from "./validation.js"

// The address a pairing code tells a device to dial. It must be TLS unless it
// is loopback, the same rule the daemon applies to its own listener, so a
// payload cannot talk a phone into a plaintext tailnet dial.
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"])

export const pairingUrlSchema = z.string().check(utf16MaxLength(512)).refine((value) => {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.username || url.password || url.search || url.hash) return false
  if (url.protocol === "wss:") return true
  return url.protocol === "ws:" && loopbackHosts.has(url.hostname)
}, "Pairing address must be wss://, or ws:// on loopback only")

// What the daemon knows about that address when it issues a code: the address
// itself, with the certificate's name and whether only this machine can reach
// it, or the one problem that leaves a device nothing to dial. The daemon
// derives it from the certificate it serves, so what the code says and what
// the device can verify are the same fact. Every surface that draws a pairing
// code reads this rather than working the address out for itself.
export const pairingAddressSchema = z.union([
  z.object({
    url: pairingUrlSchema,
    label: z.string().trim().min(1).check(utf16MaxLength(128)).optional(),
    loopback: z.boolean(),
  }).strict(),
  z.object({
    problem: z.string().trim().min(1).check(utf16MaxLength(512)),
  }).strict(),
])

export type PairingAddress = z.infer<typeof pairingAddressSchema>
