export function artifactUrlFor(rpcUrl: string, artifactId: string): string {
  const url = new URL(rpcUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = `/artifacts/${encodeURIComponent(artifactId)}`
  url.search = ""
  url.hash = ""
  return url.toString()
}
