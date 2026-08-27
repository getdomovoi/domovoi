export function artifactUrlFor(
  rpcUrl: string,
  artifactId: string,
  bridgeChannel?: string,
  parentOrigin?: string,
): string {
  const url = new URL(rpcUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = `/artifacts/${encodeURIComponent(artifactId)}`
  url.search = bridgeChannel && parentOrigin
    ? new URLSearchParams({ bridge: bridgeChannel, parentOrigin }).toString()
    : ""
  url.hash = ""
  return url.toString()
}
