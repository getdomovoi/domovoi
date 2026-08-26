export function artifactUrlFor(rpcUrl: string, artifactId: string, bridgeChannel?: string): string {
  const url = new URL(rpcUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = `/artifacts/${encodeURIComponent(artifactId)}`
  url.search = bridgeChannel ? new URLSearchParams({ bridge: bridgeChannel }).toString() : ""
  url.hash = ""
  return url.toString()
}
