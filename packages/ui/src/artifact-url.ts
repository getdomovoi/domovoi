import type { ArtifactAccess } from "@getdomovoi/protocol"

export function artifactUrlFor(
  rpcUrl: string,
  access: ArtifactAccess,
  parentOrigin?: string,
): string {
  const url = new URL(rpcUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = `/artifacts/${encodeURIComponent(access.artifactId)}`
  url.search = new URLSearchParams({
    session: access.sessionId,
    revision: String(access.revision),
    purpose: access.purpose,
    ...(access.bridgeChannel ? { bridge: access.bridgeChannel } : {}),
    ...(access.bridgeChannel && parentOrigin ? { parentOrigin } : {}),
    expires: String(access.expiresAt),
    signature: access.signature,
  }).toString()
  url.hash = ""
  return url.toString()
}
