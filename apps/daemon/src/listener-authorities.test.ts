import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { listenerAuthorities } from "./listener-authorities.js"

// S3.2 plan section 2.4 and Q46 A: each listener answers two separate
// questions. Host authorities are the Host values it serves static files and
// artifacts to; browser origins are the pages it admits to /rpc and names in
// preview frame-ancestors. They share inputs but never results: an
// advertisement setting is a Host authority and never a browser origin.

const fixtures = join(import.meta.dirname, "..", "test-fixtures", "local-owner-tls")
// Names only DNS:localhost (test-fixtures/local-owner-tls/README.md).
const localhostCertificate = readFileSync(join(fixtures, "localhost-cert.pem"), "utf8")

describe("listener authorities", () => {
  it("keeps advertisement settings out of the browser origins on TLS", () => {
    const { hostAuthorities, browserOrigins } = listenerAuthorities({
      scheme: "https", host: "127.0.0.1", port: 47831, certificate: localhostCertificate,
      hostOnlyNames: ["studio.example.ts.net", "advertised.example"], webAppLoaded: true,
    })
    expect([...hostAuthorities].sort()).toEqual([
      "127.0.0.1:47831", "advertised.example:47831", "localhost:47831", "studio.example.ts.net:47831",
    ])
    expect([...browserOrigins].sort()).toEqual(["https://127.0.0.1:47831", "https://localhost:47831"])
  })

  it("keeps advertisement settings out of the browser origins on plaintext", () => {
    const { hostAuthorities, browserOrigins } = listenerAuthorities({
      scheme: "http", host: "127.0.0.1", port: 47831,
      hostOnlyNames: ["studio.example.ts.net", "advertised.example"], webAppLoaded: true,
    })
    expect([...hostAuthorities].sort()).toEqual([
      "127.0.0.1:47831", "advertised.example:47831", "localhost:47831", "studio.example.ts.net:47831",
    ])
    expect([...browserOrigins].sort()).toEqual(["http://127.0.0.1:47831", "http://localhost:47831"])
  })

  it("admits no plaintext browser origin while no bundle is loaded", () => {
    expect([...listenerAuthorities({ scheme: "http", host: "127.0.0.1", port: 47831, webAppLoaded: false }).browserOrigins]).toEqual([])
  })

  it("names the IPv6 loopback as bound", () => {
    const { hostAuthorities, browserOrigins } = listenerAuthorities({ scheme: "http", host: "::1", port: 5000, webAppLoaded: true })
    expect([...hostAuthorities].sort()).toEqual(["[::1]:5000", "localhost:5000"])
    expect([...browserOrigins].sort()).toEqual(["http://[::1]:5000", "http://localhost:5000"])
  })

  it("never makes a plaintext origin off loopback", () => {
    const { hostAuthorities, browserOrigins } = listenerAuthorities({ scheme: "http", host: "192.0.2.10", port: 80, webAppLoaded: true })
    expect([...hostAuthorities]).toEqual(["192.0.2.10"])
    expect([...browserOrigins]).toEqual([])
  })

  it("names a tailnet listener by its address and its certificate's names, with the scheme's default port dropped", () => {
    const { hostAuthorities, browserOrigins } = listenerAuthorities({
      scheme: "https", host: "100.101.102.103", port: 443, certificate: localhostCertificate,
      hostOnlyNames: ["studio.example.ts.net"], webAppLoaded: false,
    })
    expect([...hostAuthorities].sort()).toEqual(["100.101.102.103", "localhost", "studio.example.ts.net"])
    expect([...browserOrigins].sort()).toEqual(["https://100.101.102.103", "https://localhost"])
  })

  it("skips a wildcard bind and any name that is not a plain host", () => {
    const { hostAuthorities, browserOrigins } = listenerAuthorities({
      scheme: "https", host: "0.0.0.0", port: 47831,
      hostOnlyNames: ["evil.example/path", "user@evil.example", "", "Studio.Example.TS.net", "a b"], webAppLoaded: true,
    })
    expect([...hostAuthorities]).toEqual(["studio.example.ts.net:47831"])
    expect([...browserOrigins]).toEqual([])
    expect([...listenerAuthorities({ scheme: "https", host: "::", port: 1, webAppLoaded: true }).hostAuthorities]).toEqual([])
  })

  // Codex review of S3.2 slice 5, round 1: URL rewrites these spellings to a
  // wildcard address, so the check reads the parsed hostname.
  it("skips a wildcard bind or advertised name however it is spelled", () => {
    const spellings = ["0.0.0.0", "0", "0x0", "0.0", "::", "[::]", "::0", "0:0:0:0:0:0:0:0", "[0:0:0:0:0:0:0:0]"]
    for (const scheme of ["http", "https"] as const) {
      for (const host of spellings) {
        const { hostAuthorities, browserOrigins } = listenerAuthorities({ scheme, host, port: 47831, webAppLoaded: true })
        expect([...hostAuthorities], `${scheme} ${host}`).toEqual([])
        expect([...browserOrigins], `${scheme} ${host}`).toEqual([])
      }
    }
    const { hostAuthorities, browserOrigins } = listenerAuthorities({
      scheme: "https", host: "100.64.0.1", port: 47831, hostOnlyNames: spellings, webAppLoaded: true,
    })
    expect([...hostAuthorities]).toEqual(["100.64.0.1:47831"])
    expect([...browserOrigins]).toEqual(["https://100.64.0.1:47831"])
  })

  it("still names a real bound address, IPv4 or IPv6", () => {
    expect([...listenerAuthorities({ scheme: "https", host: "100.64.0.1", port: 47831, webAppLoaded: false }).hostAuthorities]).toEqual(["100.64.0.1:47831"])
    expect([...listenerAuthorities({ scheme: "https", host: "fd7a:115c:a1e0::1", port: 47831, webAppLoaded: false }).hostAuthorities]).toEqual(["[fd7a:115c:a1e0::1]:47831"])
  })

  it("reads no name from a certificate it cannot parse", () => {
    const { browserOrigins } = listenerAuthorities({ scheme: "https", host: "100.64.0.1", port: 47831, certificate: "not a certificate", webAppLoaded: true })
    expect([...browserOrigins]).toEqual(["https://100.64.0.1:47831"])
  })
})
