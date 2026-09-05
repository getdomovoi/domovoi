import {
  deviceLabelMismatchErrorCode,
  deviceLabelMismatchSchema,
  type DeviceLabelMismatch,
  type PairedDeviceSummary,
} from "@getdomovoi/protocol"

import { DaemonRpcError } from "./client.js"

// The daemon refuses a rename whose expected label is stale and sends the row
// as it stands. Only its own error code and typed data mean that. A message
// that happens to mention a label does not.
export function deviceLabelMismatch(cause: unknown): DeviceLabelMismatch | undefined {
  if (!(cause instanceof DaemonRpcError) || cause.code !== deviceLabelMismatchErrorCode) return undefined
  const parsed = deviceLabelMismatchSchema.safeParse(cause.data)
  return parsed.success ? parsed.data : undefined
}

export function renamedElsewhereNotice(expected: string, device: PairedDeviceSummary): string {
  return `The name was changed elsewhere: ${expected} is now ${device.label}. Undo changed nothing.`
}
