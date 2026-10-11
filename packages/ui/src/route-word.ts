import { isTransportLoopbackHost, type TransportCandidate } from "@getdomovoi/protocol"

// How this client reaches the daemon, read from the endpoint it dialed. The
// app bar's machine chip (web and desktop) and the browser limits page both
// say it, so the rule lives in one place.
//
// - loopback: a loopback address (127.0.0.0/8, ::1, or either written as an
//   IPv4-mapped IPv6 address) or localhost.
// - tailnet: only what is provably Tailscale's: a MagicDNS name under ts.net,
//   an address in 100.64.0.0/10, or one in fd7a:115c:a1e0::/48. A custom
//   MagicDNS domain or a LAN address cannot be told apart from any other
//   host by its name, so it is not called the tailnet.
// - plaintext: a non-loopback endpoint without TLS (ws: or http:). The daemon
//   refuses such a listener, so a client should never hold one; if it does,
//   the word says so before anything else, rather than direct or tailnet,
//   both of which read as a protected route.
// - direct: any other host, over TLS (wss: or https:); the word claims
//   neither that it is this machine nor that it is the tailnet.
// - unknown: an endpoint that does not parse, or a scheme that says nothing
//   about TLS.
export type EndpointRoute = "loopback" | "tailnet" | "direct" | "plaintext" | "unknown"

const tls = new Set(["wss:", "https:"])
const plain = new Set(["ws:", "http:"])

// The URL parser writes an IPv4-mapped IPv6 address as [::ffff:hhhh:hhhh];
// read it as the IPv4 address it carries, so one rule covers both spellings.
function unmapped(name: string): string {
  const mapped = /^\[::ffff:([\da-f]{1,4}):([\da-f]{1,4})\]$/u.exec(name)
  if (!mapped) return name
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")
}

function isLoopbackHost(name: string): boolean {
  return isTransportLoopbackHost(name) || /^127(?:\.\d{1,3}){3}$/u.test(name)
}

function isTailnetHost(name: string): boolean {
  // At least one label before ts.net: the bare suffix is nobody's machine.
  if (/^[^.]+(?:\.[^.]+)*\.ts\.net$/u.test(name)) return true
  const ipv4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(name)
  if (ipv4) {
    const second = Number(ipv4[1])
    return second >= 64 && second <= 127
  }
  // The URL parser writes IPv6 hosts bracketed, lower case and compressed.
  // None of the prefix's three groups is zero, so compression never removes
  // one of them.
  return name.startsWith("[fd7a:115c:a1e0:")
}

export function routeOfEndpoint(endpoint: string): EndpointRoute {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return "unknown"
  }
  if (!tls.has(url.protocol) && !plain.has(url.protocol)) return "unknown"
  // A fully qualified name ends in a dot and means the same host.
  const name = unmapped(url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname)
  if (isLoopbackHost(name)) return "loopback"
  if (plain.has(url.protocol)) return "plaintext"
  if (isTailnetHost(name)) return "tailnet"
  return "direct"
}

// The chip's word for a connected machine. `dialed` is the transport kind the
// route to an attached machine was resolved to, recorded when it connected. An
// SSH forward and a WSL guest are loopback sockets to another daemon, so they
// are named for what they are. Every other kind is read from the endpoint, so
// a candidate the operator classified as tailnet or LAN still has to prove it.
export function machineRoute(endpoint: string, dialed?: TransportCandidate["kind"]): EndpointRoute | "ssh" | "wsl" {
  if (dialed === "ssh" || dialed === "wsl") return dialed
  return routeOfEndpoint(endpoint)
}
