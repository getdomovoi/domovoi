import type { DeviceIssueCodeResult, PairingAddress } from "@getdomovoi/protocol"

// What the QR must carry beside the code: the address a device dials, or the
// one problem that leaves it nothing to dial. The daemon derives it from the
// certificate it serves and sends it with the code (device.issueCode,
// 2026-09-23), so the card draws what the daemon says and guesses nothing.
export type PairingAddressReport = PairingAddress

export type IssuedPairingCode = DeviceIssueCodeResult

export function pairingAddressOf(issued: IssuedPairingCode): PairingAddressReport {
  return issued.pairingAddress
}
