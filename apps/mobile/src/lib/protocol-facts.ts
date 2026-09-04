import { protocolVersion } from "@getdomovoi/protocol"

// Stated once so the greeting cannot drift from the package the app builds
// against, which is how the desktop client's pairing broke.
export const protocolVersionForClient = protocolVersion
export const clientVersion = "0.0.1"

// The daemon binds the identity greeted at hello and now refuses any later call
// that claims a different one, so the kind is stated once rather than repeated
// at every call site where the two could drift apart.
export const clientKind = "phone" as const
