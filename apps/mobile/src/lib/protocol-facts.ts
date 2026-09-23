import { buildVersion, protocolVersion, type ClientKind } from "@getdomovoi/protocol"

// Stated once so the greeting cannot drift from the package the app builds
// against, which is how the desktop client's pairing broke.
export const protocolVersionForClient = protocolVersion
export const clientVersion = buildVersion

// The same app runs on a phone and on a tablet, and the pairing code decides
// which one it is to the daemon. The daemon binds the kind greeted at hello and
// refuses any later call that claims another, so every call names the kind
// the stored credential carries. A credential stored before the kind was kept
// was paired with a phone code, because only those ever connected.
export type HandheldClient = Extract<ClientKind, "phone" | "tablet">
export const legacyHandheldClient: HandheldClient = "phone"
