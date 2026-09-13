import { z } from "zod"

import { offsetDateTimeSchema, utf16MaxLength } from "./validation.js"

import { clientKindSchema, credentialSchema, machineIdSchema } from "./identifiers.js"
import { fleetMachineDescriptorSchema } from "./fleet.js"
import { protocolVersionSchema } from "./protocol-version.js"
import { relayChannelPinSchema, relayPublicKeySchema } from "./relay-admission.js"

export const maximumPairedDeviceLabelLength = 128
export const maximumListedDevices = 256

export const deviceIdSchema = z.string().regex(/^device-[0-9a-f]{32}$/)
export const deviceLabelSchema = z.string().trim().min(1).check(utf16MaxLength(maximumPairedDeviceLabelLength))

export const deviceCredentialBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("client"),
    client: clientKindSchema,
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
  channelPublicKey: relayPublicKeySchema.optional(),
}).strict()

export const devicePairResultSchema = z.object({
  device: pairedDeviceSchema,
  token: deviceCredentialSchema,
  relay: relayChannelPinSchema.optional(),
}).strict()

// The server derives this receipt from the authenticated socket, not a caller
// id, label or token in the request. A root bearer is not a paired client.
export const deviceCurrentResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daemon"), machineId: machineIdSchema }).strict(),
  z.object({
    kind: z.literal("client"), machineId: machineIdSchema,
    deviceId: deviceIdSchema, client: clientKindSchema,
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
}).strict()

export const deviceConfirmClaimParamsSchema = z.object({
  authToken: deviceCredentialSchema,
  machineId: machineIdSchema,
  protocolVersion: protocolVersionSchema,
}).strict()

export const deviceConfirmClaimResultSchema = z.object({ device: pairedDeviceSchema }).strict()

export const deviceIssueCodeResultSchema = z.object({
  code: pairingCodeSchema,
  expiresAt: offsetDateTimeSchema,
}).strict()

export const machineCredentialSchema = credentialSchema

export const deviceListParamsSchema = z.object({}).strict()

export const devicesResultSchema = z.object({
  devices: z.array(pairedDeviceSchema).max(maximumListedDevices),
}).strict()

export type DeviceIssueCodeResult = z.infer<typeof deviceIssueCodeResultSchema>
export type PendingDeviceClaim = z.infer<typeof pendingDeviceClaimSchema>
export type DeviceClaimResult = z.infer<typeof deviceClaimResultSchema>
export type PairedDeviceSummary = z.infer<typeof pairedDeviceSchema>
export type DeviceCredentialBinding = z.infer<typeof deviceCredentialBindingSchema>
export type DevicePairResult = z.infer<typeof devicePairResultSchema>
export type DevicesResult = z.infer<typeof devicesResultSchema>
export type DeviceRenameParams = z.infer<typeof deviceRenameParamsSchema>
export type DeviceRenameResult = z.infer<typeof deviceRenameResultSchema>
export type DeviceLabelMismatch = z.infer<typeof deviceLabelMismatchSchema>
