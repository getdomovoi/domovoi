import { z } from "zod"

import { clientKindSchema, credentialSchema, machineIdSchema } from "./identifiers.js"

export const maximumPairedDeviceLabelLength = 128
export const maximumListedDevices = 256

export const deviceIdSchema = z.string().regex(/^device-[0-9a-f]{32}$/)
export const deviceLabelSchema = z.string().trim().min(1).max(maximumPairedDeviceLabelLength)

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
  pairedAt: z.string().datetime({ offset: true }),
  binding: deviceCredentialBindingSchema,
  lastSeenAt: z.string().datetime({ offset: true }).optional(),
  revokedAt: z.string().datetime({ offset: true }).optional(),
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
}).strict()

export const devicePairResultSchema = z.object({
  device: pairedDeviceSchema,
  token: deviceCredentialSchema,
}).strict()

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
  .max(maximumPairedDeviceLabelLength)
  .regex(/^\P{Cc}*$/u, "A device label cannot contain control characters")

export const deviceRenameParamsSchema = z.object({
  deviceId: deviceIdSchema,
  label: deviceRenameLabelSchema,
}).strict()

export const deviceRenameResultSchema = z.object({
  device: pairedDeviceSchema,
}).strict()

export const pairingCodeSchema = z.string().regex(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/)

export const deviceClaimParamsSchema = z.object({
  code: pairingCodeSchema,
  label: deviceLabelSchema,
  machineId: machineIdSchema,
}).strict()

export const deviceIssueCodeResultSchema = z.object({
  code: pairingCodeSchema,
  expiresAt: z.string().datetime({ offset: true }),
}).strict()

export const machineCredentialSchema = credentialSchema

export const deviceSaveCredentialParamsSchema = z.object({
  machineId: machineIdSchema,
  credential: machineCredentialSchema,
}).strict()

export const deviceMachineCredentialParamsSchema = z.object({
  machineId: machineIdSchema,
}).strict()

export const deviceMachineCredentialResultSchema = z.object({
  credential: machineCredentialSchema,
}).strict()

export const deviceSaveCredentialResultSchema = z.object({ saved: z.literal(true) }).strict()

export const deviceListParamsSchema = z.object({}).strict()

export const devicesResultSchema = z.object({
  devices: z.array(pairedDeviceSchema).max(maximumListedDevices),
}).strict()

export type DeviceIssueCodeResult = z.infer<typeof deviceIssueCodeResultSchema>
export type PairedDeviceSummary = z.infer<typeof pairedDeviceSchema>
export type DeviceCredentialBinding = z.infer<typeof deviceCredentialBindingSchema>
export type DevicePairResult = z.infer<typeof devicePairResultSchema>
export type DevicesResult = z.infer<typeof devicesResultSchema>
export type DeviceRenameParams = z.infer<typeof deviceRenameParamsSchema>
export type DeviceRenameResult = z.infer<typeof deviceRenameResultSchema>
export type DeviceSaveCredentialParams = z.infer<typeof deviceSaveCredentialParamsSchema>
export type DeviceSaveCredentialResult = z.infer<typeof deviceSaveCredentialResultSchema>
export type DeviceMachineCredentialParams = z.infer<typeof deviceMachineCredentialParamsSchema>
export type DeviceMachineCredentialResult = z.infer<typeof deviceMachineCredentialResultSchema>
