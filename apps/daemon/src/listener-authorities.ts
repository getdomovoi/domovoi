import { certificateHostNames } from "./pairing-address.js"
import { isLoopbackHost } from "./transport-config.js"

// S3.2 plan section 2.4 and Q46 A: what one listener answers to, computed
// after listen so the actual port is known. Two separate answers from shared
// inputs:
//
// - hostAuthorities: the Host values this listener serves the web app to.
//   The bound host, localhost on a loopback bind, each certificate name on
//   TLS, and the advertisement settings (DOMOVOI_ADVERTISE_HOST and
//   DOMOVOI_TAILNET_HOST) the caller passes as hostOnlyNames.
// - browserOrigins: the pages this listener admits to /rpc and names in a
//   preview's frame-ancestors. Only the bound host and the certificate names,
//   with this listener's scheme and port. On plaintext, only the literal
//   loopback origins, and only while a web app bundle is loaded: over
//   plaintext a rebound name can make Origin and Host agree, but a rebinding
//   page cannot claim a literal loopback origin. An advertisement setting
//   never becomes a browser origin, and nothing here reads Host, a forwarded
//   header or any other request value.
//
// Both sets hold canonical forms from URL: lowercase names, bracketed IPv6,
// and no port when it is the scheme's default (80 or 443), which is how a
// browser writes Host and Origin for that port.

export type ListenerFacts = {
  scheme: "http" | "https"
  // The host the listener was bound to, as configured.
  host: string
  // The port it actually listens on.
  port: number
  // PEM of the certificate a TLS listener serves.
  certificate?: string
  hostOnlyNames?: readonly string[]
  webAppLoaded: boolean
}

export type ListenerAuthorities = {
  hostAuthorities: ReadonlySet<string>
  browserOrigins: ReadonlySet<string>
}

// Compared after parsing: URL rewrites 0, 0x0 and 0:0:0:0:0:0:0:0 to these.
const wildcardHostnames = new Set(["0.0.0.0", "[::]"])

// A plain host name or IP literal only: URL alone would accept credentials,
// a path or a port inside the value and quietly drop them. A wildcard address
// is no name a client dials, however it is spelled.
function canonicalUrl(scheme: ListenerFacts["scheme"], host: string, port: number): URL | undefined {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  if (!/^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\])$/.test(bracketed)) return undefined
  try {
    const url = new URL(`${scheme}://${bracketed}:${port}`)
    return wildcardHostnames.has(url.hostname) ? undefined : url
  } catch {
    return undefined
  }
}

export function listenerAuthorities(facts: ListenerFacts): ListenerAuthorities {
  const hostAuthorities = new Set<string>()
  const browserOrigins = new Set<string>()
  const loopback = isLoopbackHost(facts.host)
  const names = facts.scheme === "https" && facts.certificate !== undefined ? certificateHostNames(facts.certificate) : []

  const own = [facts.host, ...(loopback ? ["localhost"] : []), ...names]
  for (const host of own) {
    const url = canonicalUrl(facts.scheme, host, facts.port)
    if (url === undefined) continue
    hostAuthorities.add(url.host)
    if (facts.scheme === "https") {
      // localhost is a browser origin on TLS only when the certificate names it.
      if (host !== "localhost" || names.includes("localhost")) browserOrigins.add(url.origin)
    } else if (loopback && facts.webAppLoaded) {
      browserOrigins.add(url.origin)
    }
  }
  for (const host of facts.hostOnlyNames ?? []) {
    const url = canonicalUrl(facts.scheme, host, facts.port)
    if (url !== undefined) hostAuthorities.add(url.host)
  }
  return { hostAuthorities, browserOrigins }
}
