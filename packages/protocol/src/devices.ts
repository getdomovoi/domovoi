import { z } from "zod"

import { pairingAddressSchema } from "./pairing-url.js"
import { offsetDateTimeSchema, utf16MaxLength } from "./validation.js"

import {
  clientKindSchema,
  credentialSchema,
  deviceIdSchema,
  deviceLabelSchema,
  machineIdSchema,
  maximumPairedDeviceLabelLength,
} from "./identifiers.js"
import { fleetMachineDescriptorSchema } from "./fleet.js"
import { protocolCompatibilitySchema, protocolVersionSchema } from "./protocol-version.js"
import { relayChannelPinSchema, relayPublicKeySchema } from "./relay-admission.js"
import { relayIdentityPinSchema } from "./relay-identity.js"

// Defined in identifiers.ts so the thread can name a device without an import
// cycle; re-exported here, where the device schemas are read from.
export { deviceIdSchema, deviceLabelSchema, maximumPairedDeviceLabelLength }

export const maximumListedDevices = 256

export const clientAccessSchema = z.enum(["full", "watching"])

export const deviceCredentialBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("client"),
    client: clientKindSchema,
    clientAccess: clientAccessSchema.default("full"),
  }).strict(),
  z.object({
    kind: z.literal("machine"),
    machineId: machineIdSchema,
  }).strict(),
  // Revoked rows survive both identity-binding migrations so an operator can
  // see why an old pairing stopped working without inventing an identity that
  // was never recorded.
  z.object({
    kind: z.literal("unbound"),
    previousRole: z.enum(["unknown", "client"]),
  }).strict(),
])

export const deviceRevocationReasonSchema = z.enum([
  "legacy-unbound-credential",
  "legacy-unbound-client-kind",
])

// Credentials are returned once at pairing and never described anywhere else,
// so every device shape below is strict.
export const deviceCredentialSchema = credentialSchema

export const pairedDeviceSchema = z.object({
  id: deviceIdSchema,
  label: deviceLabelSchema,
  pairedAt: offsetDateTimeSchema,
  binding: deviceCredentialBindingSchema,
  lastSeenAt: offsetDateTimeSchema.optional(),
  revokedAt: offsetDateTimeSchema.optional(),
  revocationReason: deviceRevocationReasonSchema.optional(),
}).strict().superRefine((device, context) => {
  if (device.revocationReason !== undefined && device.revokedAt === undefined) {
    context.addIssue({
      code: "custom",
      path: ["revocationReason"],
      message: "A device revocation reason requires a revocation time",
    })
  }
  if (device.binding.kind === "unbound") {
    if (device.revokedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["binding"],
        message: "An unbound legacy device must be revoked",
      })
    }
    const expectedReason = device.binding.previousRole === "client"
      ? "legacy-unbound-client-kind"
      : "legacy-unbound-credential"
    if (device.revocationReason !== expectedReason) {
      context.addIssue({
        code: "custom",
        path: ["revocationReason"],
        message: "A legacy device revocation reason must match its previous role",
      })
    }
  } else if (device.revocationReason !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["revocationReason"],
      message: "A bound device cannot carry a legacy revocation reason",
    })
  }
})

export const devicePairParamsSchema = z.object({
  label: deviceLabelSchema,
  client: clientKindSchema,
  // client remains the authenticated issuer. Only local root can mint this
  // separate kind-bound credential. Omission retains the existing behavior.
  targetClient: clientKindSchema.optional(),
  clientAccess: clientAccessSchema.optional(),
  channelPublicKey: relayPublicKeySchema.optional(),
}).strict()

export const devicePairResultSchema = z.object({
  device: pairedDeviceSchema,
  token: deviceCredentialSchema,
  relay: relayChannelPinSchema.optional(),
  relayIdentity: relayIdentityPinSchema.optional(),
}).strict().superRefine((result, context) => {
  if (result.relay === undefined && result.relayIdentity === undefined) return
  if (!result.relay || !result.relayIdentity
    || result.relay.suite !== result.relayIdentity.channel.suite
    || result.relay.responderPublicKey !== result.relayIdentity.channel.responderPublicKey) {
    context.addIssue({ code: "custom", message: "Relay enrollment requires matching channel and identity pins" })
  }
})

// The server derives this receipt from the authenticated socket, not a caller
// id, label or token in the request. A root bearer is not a paired client.
export const deviceCurrentResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daemon"), machineId: machineIdSchema }).strict(),
  z.object({
    kind: z.literal("client"), machineId: machineIdSchema,
    deviceId: deviceIdSchema, client: clientKindSchema, clientAccess: clientAccessSchema.default("full"),
  }).strict(),
])

export type DeviceCurrent = z.infer<typeof deviceCurrentResultSchema>

export const deviceRevokeParamsSchema = z.object({
  deviceId: deviceIdSchema,
  client: clientKindSchema,
}).strict()

export const deviceRotateParamsSchema = deviceRevokeParamsSchema

// A rename is a label change and nothing else: the request names the row and
// the new word for it. Identity, binding, and credential material have no
// field here, so a client cannot ask for them to move.
export const deviceRenameLabelSchema = z.string()
  .trim()
  .min(1)
  .check(utf16MaxLength(maximumPairedDeviceLabelLength))
  .regex(/^\P{Cc}*$/u, "A device label cannot contain control characters")

// The expected label is a precondition: when present, the daemon renames only
// a row whose label still reads that way, so an Undo sent after another client
// renamed the same row refuses instead of overwriting that rename.
export const deviceRenameParamsSchema = z.object({
  deviceId: deviceIdSchema,
  label: deviceRenameLabelSchema,
  expectedLabel: deviceLabelSchema.optional(),
}).strict()

export const deviceRenameResultSchema = z.object({
  device: pairedDeviceSchema,
}).strict()

// The data on a deviceLabelMismatchErrorCode refusal: the row as it is now, so
// the client can show the current label without another round trip.
export const deviceLabelMismatchSchema = z.object({
  kind: z.literal("device-label-mismatch"),
  device: pairedDeviceSchema,
}).strict()

export const pairingCodeSchema = z.string().regex(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/)

export const deviceClaimParamsSchema = z.object({
  code: pairingCodeSchema,
  label: deviceLabelSchema,
  machineId: machineIdSchema,
  // Compatibility is checked before the one-time code is consumed.
  protocolVersion: protocolVersionSchema,
  channelPublicKey: relayPublicKeySchema.optional(),
}).strict()

// A claim is not a paired device. Only its confirmation capability exists
// until the source has durably stored the token. It cannot authenticate hello.
export const pendingDeviceClaimSchema = z.object({
  state: z.literal("pending"),
  deviceId: deviceIdSchema,
  machineId: machineIdSchema,
  expiresAt: offsetDateTimeSchema,
}).strict()

export const deviceClaimResultSchema = z.object({
  claim: pendingDeviceClaimSchema,
  token: deviceCredentialSchema,
  machine: fleetMachineDescriptorSchema,
  relay: relayChannelPinSchema.optional(),
  relayIdentity: relayIdentityPinSchema.optional(),
}).strict().superRefine((result, context) => {
  if (result.relay === undefined && result.relayIdentity === undefined) return
  if (!result.relay || !result.relayIdentity
    || result.relay.suite !== result.relayIdentity.channel.suite
    || result.relay.responderPublicKey !== result.relayIdentity.channel.responderPublicKey
    || result.machine.id !== result.relayIdentity.machineId) {
    context.addIssue({ code: "custom", message: "Relay enrollment requires matching channel, identity and daemon pins" })
  }
})

export const deviceConfirmClaimParamsSchema = z.object({
  authToken: deviceCredentialSchema,
  machineId: machineIdSchema,
  protocolVersion: protocolVersionSchema,
}).strict()

export const deviceConfirmClaimResultSchema = z.object({ device: pairedDeviceSchema }).strict()

// A code issued for a client kind mints that kind and no other. The kind is
// recorded with the code rather than asked of the claimer, so a code shown for
// a phone cannot be spent into a desktop credential by a claimer that says so.
export const deviceIssueCodeParamsSchema = z.object({
  targetClient: clientKindSchema.optional(),
  clientAccess: clientAccessSchema.optional(),
  // The issuer's label names the device the code pairs.
  label: deviceRenameLabelSchema.optional(),
}).strict().refine((params) => params.label === undefined || params.targetClient !== undefined, {
  path: ["label"],
  message: "A label requires a target client; a machine pairing names itself at claim",
})

// The web app a pairing code can be opened in, as the daemon's owner set it.
// An absolute http(s) address with no credentials and no fragment, so a card
// can build a link from it without carrying a secret or losing its own part.
// Whitespace and control characters are refused in the raw text: the URL parser
// would strip or encode them, so the address that parses is not the one set.
export const maximumWebAppUrlLength = 2_048

function hasWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\s/u.test(character)) return true
  }
  return false
}

export const webAppUrlSchema = z.string().check(utf16MaxLength(maximumWebAppUrlLength)).refine((value) => {
  if (hasWhitespaceOrControl(value) || value.includes("#")) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
}, "Expected an absolute http or https URL without whitespace, control characters, credentials or a fragment")

// The code comes with the address a device dials to spend it, or the problem
// that leaves it nothing to dial, so the desktop card, the web connect page
// and the command line draw one address and none of them guesses it. The web
// app address is there only when the daemon's owner configured one.
// pairingId names one issued code without repeating it, so the outcome the
// daemon later reports can say which code it was about.
export const pairingIdSchema = z.string().regex(/^pairing-[0-9a-f]{32}$/)

export const deviceIssueCodeResultSchema = z.object({
  pairingId: pairingIdSchema,
  code: pairingCodeSchema,
  expiresAt: offsetDateTimeSchema,
  pairingAddress: pairingAddressSchema,
  webAppUrl: webAppUrlSchema.optional(),
}).strict()

// What became of a client code (one issued with a targetClient), told only to
// the connection whose device.issueCode returned it (ruling Q354 A). Every
// other connection, including others holding the same daemon credential and
// the device that spent the code, hears nothing of it. The device that spent
// it still gets the uniform "Pairing was refused" answer.
//
// - redeemed: the code paired this device. The code is spent.
// - refused protocol-mismatch: a device holding the right code speaks another
//   protocol. The code was not spent and still pairs until it expires.
// - refused device-limit: the right code, but the paired device list is full.
//   The code is spent.
// - refused wrong-kind: the right code, spent as a machine pairing. The code is
//   spent and nothing was paired.
// - closed attempts-exhausted: wrong codes used up the attempts. The code is
//   spent.
// - closed replaced: another code was issued, which ends this one.
//
// A code that runs out its time sends nothing: the issuer has its expiresAt.
// label is the name the redeeming device gave itself; it is that device's
// text, bounded like a device label.
const pairedClientDeviceSchema = pairedDeviceSchema.refine(
  (device) => device.binding.kind === "client" && device.revokedAt === undefined,
  { message: "A redeemed client code pairs a live client device" },
)

export const deviceCodeOutcomeNotificationSchema = z.union([
  z.object({
    pairingId: pairingIdSchema,
    outcome: z.literal("redeemed"),
    device: pairedClientDeviceSchema,
  }).strict(),
  z.object({
    pairingId: pairingIdSchema,
    outcome: z.literal("refused"),
    reason: z.literal("protocol-mismatch"),
    label: deviceLabelSchema,
    daemonProtocolVersion: protocolVersionSchema,
    clientProtocolVersion: protocolVersionSchema,
    compatibility: protocolCompatibilitySchema.exclude(["compatible"]),
  }).strict(),
  z.object({
    pairingId: pairingIdSchema,
    outcome: z.literal("refused"),
    reason: z.literal("device-limit"),
    label: deviceLabelSchema,
  }).strict(),
  z.object({
    pairingId: pairingIdSchema,
    outcome: z.literal("refused"),
    reason: z.literal("wrong-kind"),
  }).strict(),
  z.object({
    pairingId: pairingIdSchema,
    outcome: z.literal("closed"),
    reason: z.enum(["attempts-exhausted", "replaced"]),
  }).strict(),
])

// Redeeming is one step, unlike a machine claim: a client stores its
// credential before it answers anything, so there is nothing to confirm
// afterwards. A lost reply costs the code, and the machine shows another.
export const deviceRedeemCodeParamsSchema = z.object({
  code: pairingCodeSchema,
  label: deviceLabelSchema,
  protocolVersion: protocolVersionSchema,
}).strict()

export const deviceListParamsSchema = z.object({}).strict()

export const devicesResultSchema = z.object({
  devices: z.array(pairedDeviceSchema).max(maximumListedDevices),
}).strict()

export type ClientAccess = z.infer<typeof clientAccessSchema>
export type DeviceIssueCodeResult = z.infer<typeof deviceIssueCodeResultSchema>
export type DeviceCodeOutcomeNotification = z.infer<typeof deviceCodeOutcomeNotificationSchema>
export type PendingDeviceClaim = z.infer<typeof pendingDeviceClaimSchema>
export type DeviceClaimResult = z.infer<typeof deviceClaimResultSchema>
export type PairedDeviceSummary = z.infer<typeof pairedDeviceSchema>
export type DeviceCredentialBinding = z.infer<typeof deviceCredentialBindingSchema>
export type DevicePairResult = z.infer<typeof devicePairResultSchema>
export type DevicesResult = z.infer<typeof devicesResultSchema>
export type DeviceRenameParams = z.infer<typeof deviceRenameParamsSchema>
export type DeviceRenameResult = z.infer<typeof deviceRenameResultSchema>
export type DeviceLabelMismatch = z.infer<typeof deviceLabelMismatchSchema>
