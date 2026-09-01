import { z } from "zod"

import { clientKindSchema } from "./schema.js"

export const maximumPairedDeviceLabelLength = 128
export const maximumListedDevices = 256

export const deviceIdSchema = z.string().regex(/^device-[0-9a-f]{32}$/)
export const deviceLabelSchema = z.string().trim().min(1).max(maximumPairedDeviceLabelLength)

// Credentials are returned once at pairing and never described anywhere else,
// so every device shape below is strict.
export const deviceCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const pairedDeviceSchema = z.object({
  id: deviceIdSchema,
  label: deviceLabelSchema,
  pairedAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }).optional(),
  revokedAt: z.string().datetime({ offset: true }).optional(),
}).strict()

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

export const pairingCodeSchema = z.string().regex(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/)

export const deviceClaimParamsSchema = z.object({
  code: pairingCodeSchema,
  label: deviceLabelSchema,
}).strict()

export const deviceIssueCodeResultSchema = z.object({
  code: pairingCodeSchema,
  expiresAt: z.string().datetime({ offset: true }),
}).strict()

export const machineCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const deviceSaveCredentialParamsSchema = z.object({
  machineId: z.string().regex(/^machine-[0-9a-f]{32}$/),
  credential: machineCredentialSchema,
}).strict()

export const deviceSaveCredentialResultSchema = z.object({ saved: z.literal(true) }).strict()

export const deviceListParamsSchema = z.object({}).strict()

export const devicesResultSchema = z.object({
  devices: z.array(pairedDeviceSchema).max(maximumListedDevices),
}).strict()

export type DeviceIssueCodeResult = z.infer<typeof deviceIssueCodeResultSchema>
export type PairedDeviceSummary = z.infer<typeof pairedDeviceSchema>
export type DevicePairResult = z.infer<typeof devicePairResultSchema>
export type DevicesResult = z.infer<typeof devicesResultSchema>
export type DeviceSaveCredentialParams = z.infer<typeof deviceSaveCredentialParamsSchema>
export type DeviceSaveCredentialResult = z.infer<typeof deviceSaveCredentialResultSchema>
