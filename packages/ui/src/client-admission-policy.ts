import { deviceIdSchema, machineIdSchema, type ClientKind, type DeviceCurrent, type FleetClientRouteRefusal } from "@getdomovoi/protocol"

export type ClientAdmission = { machineId: string; deviceId?: string }
export type ClientAdmissionRefusal = FleetClientRouteRefusal | "client-credential-required" | "verification-unavailable"

const messages: Record<ClientAdmissionRefusal, string> = {
  "not-enrolled": "That machine is no longer enrolled. Refresh Fleet and enroll it again before authorizing this client.",
  "machine-unavailable": "That machine is not reachable. Start its daemon and refresh Fleet before trying again.",
  "pairing-required": "The daemon-to-daemon pairing needs replacing. Enroll the machine again, then authorize this client separately.",
  "credential-store-unavailable": "This daemon cannot read its machine credential. Unlock its keychain and try again.",
  "protocol-mismatch": "Update both daemons and this app before authorizing remote client access.",
  "identity-mismatch": "The endpoint answered as a different machine. No workspace was opened. Check the route and enroll the intended machine again.",
  "client-route-unavailable": "No enrolled route is usable from this client. Check the target's TLS endpoint. WSL and local SSH routes require this app on the source machine.",
  "route-timeout": "The machine did not answer within the connection budget. Check its network and daemon, then try again.",
  "client-credential-required": "The credential was refused or is not for this client. Ask the target's operator for a new client credential of this app's kind. Do not use a machine credential or daemon root token.",
  "verification-unavailable": "This client could not verify the remote credential. Update both daemons and this app, then try again. No workspace was opened.",
}

// Only local enum copy crosses this error seam. Remote error text can quote a
// submitted secret, so it is never rendered as an admission remedy.
export class ClientAdmissionError extends Error {
  constructor(readonly reason: ClientAdmissionRefusal) {
    super(messages[reason])
    this.name = "ClientAdmissionError"
  }
}

export function parseClientAdmission(expected: ClientAdmission): ClientAdmission {
  return { machineId: machineIdSchema.parse(expected.machineId),
    ...(expected.deviceId === undefined ? {} : { deviceId: deviceIdSchema.parse(expected.deviceId) }) }
}

export function verifyClientAdmission(expected: ClientAdmission, kind: ClientKind, receipt: DeviceCurrent): string {
  if (receipt.machineId !== expected.machineId) throw new ClientAdmissionError("identity-mismatch")
  if (receipt.kind !== "client" || receipt.client !== kind
    || (expected.deviceId !== undefined && receipt.deviceId !== expected.deviceId)) {
    throw new ClientAdmissionError("client-credential-required")
  }
  return receipt.deviceId
}
