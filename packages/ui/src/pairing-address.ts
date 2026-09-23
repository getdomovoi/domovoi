import type { DeviceIssueCodeResult } from "@getdomovoi/protocol"

// What the QR must carry beside the code: the address a device dials, which
// only the daemon can name (it derives it from its own certificate), or the
// reason there is none. The daemon lane is adding this to device.issueCode
// (ND8, 2026-09-23); until the protocol carries it, a result without the field
// is reported as such rather than guessed at from this machine's transports.
export type PairingAddressReport =
  | { url: string; label?: string | undefined; loopback: boolean }
  | { problem: string }

export type IssuedPairingCode = DeviceIssueCodeResult & { pairingAddress?: PairingAddressReport | undefined }

export const pairingAddressNotReported = "This daemon did not report an address for the code. Update the daemon, or run domovoid pair --client phone on it."

export function pairingAddressOf(issued: IssuedPairingCode): PairingAddressReport {
  const report = issued.pairingAddress
  if (!report) return { problem: pairingAddressNotReported }
  return report
}
