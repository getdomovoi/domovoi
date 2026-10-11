import { isTransportLoopbackHost } from "@getdomovoi/protocol"

// How this client reaches the daemon, read from the endpoint it dialed. The
// app bar's machine chip (web and desktop) and the browser limits page both
// say it, so the rule lives in one place.
//
// - loopback: a loopback address or localhost.
// - tailnet: only what is provably Tailscale's: a MagicDNS name under ts.net,
//   an address in 100.64.0.0/10, or one in fd7a:115c:a1e0::/48. A custom
//   MagicDNS domain or a LAN address cannot be told apart from any other
//   host by its name, so it is not called the tailnet.
// - plaintext: a non-loopback endpoint without TLS (ws: or http:). The daemon
//   refuses such a listener, so a client should never hold one; if it does,
//   the word says so before anything else, rather than direct or tailnet,
//   both of which read as a protected route.
// - direct: any other host, over TLS; the word claims neither that it is this
//   machine nor that it is the tailnet.
// - unknown: an endpoint that does not parse.
export type EndpointRoute = "loopback" | "tailnet" | "direct" | "plaintext" | "unknown"

function isLoopbackHost(hostname: string): boolean {
  return isTransportLoopbackHost(hostname) || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
}

function isTailnetHost(hostname: string): boolean {
  const name = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname
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
  const { hostname, protocol } = url
  if (isLoopbackHost(hostname)) return "loopback"
  if (protocol === "ws:" || protocol === "http:") return "plaintext"
  if (isTailnetHost(hostname)) return "tailnet"
  return "direct"
}

// The chip's word for a connected machine. `connection` is the fleet's record
// of how an attached machine is reached; a loopback endpoint to another machine
// is a forwarded port, so an SSH route is named as one rather than as loopback.
export function machineRoute(endpoint: string, connection?: string): EndpointRoute | "ssh" {
  const route = routeOfEndpoint(endpoint)
  return route === "loopback" && connection === "ssh" ? "ssh" : route
}
