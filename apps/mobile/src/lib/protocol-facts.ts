import { protocolVersion } from "@getdomovoi/protocol"

// Stated once so the greeting cannot drift from the package the app builds
// against, which is how the desktop client's pairing broke.
export const protocolVersionForClient = protocolVersion
export const clientVersion = "0.0.1"
