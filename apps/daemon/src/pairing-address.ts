import { X509Certificate } from "node:crypto"
import { isIPv4 } from "node:net"

import { isLoopbackHost } from "./transport-config.js"

// Where a scanned code tells a device to dial. This is not the address the
// daemon binds: the documented tailnet setup binds an IPv4 address and serves
// a certificate issued for the machine's DNS name, and a phone that dials the
// address rather than the name fails TLS before it sends anything. The name
// comes from the certificate the daemon is already serving, so what the code
// says and what the phone can verify are the same fact.

export type PairingAddress = { url: string; label?: string; loopback: boolean }
export type PairingAddressProblem = { problem: string }

// A problem travels in the issueCode result, which bounds it at 512
// characters. A certificate's names and a configured path are the unbounded
// parts, so they are shortened here rather than failing the code's issue.
const maximumProblemLength = 512
const namedHosts = 3

function boundedPath(path: string): string {
  return path.length <= 160 ? path : `…${path.slice(-159)}`
}

function bounded(problem: string): string {
  return problem.length <= maximumProblemLength ? problem : `${problem.slice(0, maximumProblemLength - 1)}…`
}

export function certificateHostNames(certificate: string): string[] {
  let parsed: X509Certificate
  try { parsed = new X509Certificate(certificate) } catch { return [] }
  const entries = (parsed.subjectAltName ?? "").split(",").map((entry) => entry.trim())
  const names = entries.filter((entry) => entry.startsWith("DNS:")).map((entry) => entry.slice("DNS:".length))
  const addresses = new Set(entries.filter((entry) => entry.startsWith("IP Address:")).map((entry) => entry.slice("IP Address:".length)))
  // A wildcard certificate names no single host a code could carry, and an
  // entry that is no host name (such as "example.com/path") would give a URL
  // whose host the certificate does not name. TLS checks an IP address only
  // against IP entries, so an IP literal written as a DNS entry counts only
  // when an IP entry names it too.
  return names.filter((name) => name.length > 0 && !name.startsWith("*") && isHostName(name)
    && (!isIPv4(name) || addresses.has(name)))
}

const hostLabel = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/u

// A DNS host name the URL keeps as it is: labels of letters, digits and inner
// hyphens, 253 characters at most, with one final dot allowed.
function isHostName(name: string): boolean {
  const labels = name.endsWith(".") ? name.slice(0, -1) : name
  if (labels.length > 253 || !labels.split(".").every((label) => hostLabel.test(label))) return false
  try {
    return new URL(`wss://${name}:1/`).hostname === name.toLowerCase()
  } catch {
    return false
  }
}

const plainLoopbackHosts = new Set(["127.0.0.1", "::1", "localhost"])

// The wire bounds a label at 128 characters; a longer host goes without one.
const maximumLabelLength = 128

export function pairingAddressFor(
  config: { host: string; port: number; tls?: { certPath: string } | undefined },
  read: (path: string) => string,
): PairingAddress | PairingAddressProblem {
  if (config.tls === undefined) {
    // Plain ws:// is dialable on the wire only on these three; any other
    // loopback address needs a certificate like any remote one.
    if (!plainLoopbackHosts.has(config.host)) {
      return { problem: "This daemon serves no certificate, so a device has no address it can verify. Give it a DNS name with a certificate, then run this again." }
    }
    const host = config.host.includes(":") ? `[${config.host}]` : config.host
    return { url: `ws://${host}:${config.port}/rpc`, loopback: true }
  }

  let certificate: string
  try { certificate = read(config.tls.certPath) } catch {
    return { problem: bounded(`This daemon's certificate could not be read at ${boundedPath(config.tls.certPath)}, so there is no name to put in a pairing code.`) }
  }
  const names = certificateHostNames(certificate)
  if (names.length === 0) {
    return { problem: "This daemon's certificate names no host a device could dial. Issue one for the machine's DNS name, then run this again." }
  }
  if (names.length > 1) {
    // Picking one would be a guess about which name the device can resolve.
    const listed = names.length <= namedHosts
      ? names.join(", ")
      : `${names.slice(0, namedHosts).join(", ")} and ${names.length - namedHosts} more`
    return { problem: bounded(`This daemon's certificate names more than one host (${listed}), so which one a device should dial is not this command's to choose.`) }
  }
  // Who can reach the listener is a fact about where it is bound, not about
  // TLS: a certificate served on 127.0.0.1 still answers only this machine.
  const name = names[0]!
  return {
    url: `wss://${name}:${config.port}/rpc`,
    ...(name.length <= maximumLabelLength ? { label: name } : {}),
    loopback: isLoopbackHost(config.host),
  }
}
