import type { ArtifactAccess } from "@getdomovoi/protocol"

export function artifactUrlFor(rpcUrl: string, access: ArtifactAccess): string {
  const url = new URL(rpcUrl)
  // An artifact travels over the same protection the rpc connection has. Only a
  // plaintext socket becomes plaintext http; anything already secure stays
  // secure, including an rpc url that was given as https to begin with.
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
