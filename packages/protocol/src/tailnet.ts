import { z } from "zod"

import { offsetDateTimeSchema, utf16MaxLength } from "./validation.js"

// TailnetReach (Q404 A). The daemon's own account of its second listener, the
// one bound to this machine's Tailscale address beside loopback. A client draws
// this rather than what the switch last asked for: the listener can be refused
// (no certificate, an expired one, an address that is not on this machine) while
// the daemon answers on loopback as before.
//
// address: the address the daemon binds, an IPv4 or IPv6 literal (45 characters
// at most). certificateExpiresAt: the certificate's notAfter, so a client can say
// when it needs renewing. retrying: the daemon tries to bind the address again on
// its own, as it does when Tailscale was not up yet.
const addressSchema = z.string().min(1).check(utf16MaxLength(45))

export const tailnetListenerStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("off") }).strict(),
  z.object({
    state: z.literal("listening"),
    address: addressSchema,
    port: z.number().int().min(1).max(65_535),
    certificateExpiresAt: offsetDateTimeSchema,
  }).strict(),
  z.object({
    state: z.literal("refused"),
    address: addressSchema,
    reason: z.string().trim().min(1).check(utf16MaxLength(512)),
    retrying: z.boolean(),
    certificateExpiresAt: offsetDateTimeSchema.optional(),
  }).strict(),
])

export const tailnetStatusParamsSchema = z.object({}).strict()
export const tailnetStatusResultSchema = tailnetListenerStatusSchema

export type TailnetListenerStatus = z.infer<typeof tailnetListenerStatusSchema>
