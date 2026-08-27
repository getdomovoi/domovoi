import type { ArtifactAccess } from "@getdomovoi/protocol"

export function artifactUrlFor(rpcUrl: string, access: ArtifactAccess): string {
  const url = new URL(rpcUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = `/artifacts/${encodeURIComponent(access.artifactId)}`
  url.search = new URLSearchParams({
    ...(access.bridgeChannel ? { bridge: access.bridgeChannel } : {}),
    expires: String(access.expiresAt),
    signature: access.signature,
  }).toString()
  url.hash = ""
  return url.toString()
}
