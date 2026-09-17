import type { ArtifactAccess } from "@getdomovoi/protocol"

// A signed grant from artifact.authorize becomes the address the render is
// fetched from. It travels over the same protection the rpc socket has: a
// plaintext loopback socket becomes plain http, and anything secure stays so.
export function artifactUrlFor(rpcUrl: string, access: ArtifactAccess): string {
  const url = new URL(rpcUrl)
  url.protocol = url.protocol === "ws:" || url.protocol === "http:" ? "http:" : "https:"
  url.pathname = `/artifacts/${encodeURIComponent(access.artifactId)}`
  url.search = new URLSearchParams({
    session: access.sessionId,
    revision: String(access.revision),
    purpose: access.purpose,
    ...(access.bridgeChannel ? { bridge: access.bridgeChannel } : {}),
    ...(access.parentOrigin ? { parentOrigin: access.parentOrigin } : {}),
    expires: String(access.expiresAt),
    signature: access.signature,
  }).toString()
  url.hash = ""
  return url.toString()
}
