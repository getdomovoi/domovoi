import { describe, expect, it } from "vitest"

import { listenerAuthorities, type ListenerFacts } from "./listener-authorities.js"
import { canonicalAuthority } from "./web-app-http.js"

// S3.2 plan section 2.4: the web app and artifacts answer a request when its
// Host, in canonical form, is one of the listener's Host authorities. These
// pin the canonical form both rely on, and the decision it gives.

function answers(host: string | undefined, facts: Omit<ListenerFacts, "webAppLoaded">): boolean {
  const authority = canonicalAuthority(host, facts.scheme)
  return authority !== undefined && listenerAuthorities({ ...facts, webAppLoaded: false }).hostAuthorities.has(authority)
}

describe("canonical Host authority", () => {
  it("folds the case of a DNS name", () => {
    expect(canonicalAuthority("Studio.Example.TS.net:47831", "https")).toBe("studio.example.ts.net:47831")
  })

  it("keeps a trailing dot, so it names no listener authority", () => {
    expect(canonicalAuthority("studio.example.ts.net.:47831", "https")).toBe("studio.example.ts.net.:47831")
    expect(answers("studio.example.ts.net.:47831", { scheme: "https", host: "100.64.0.1", port: 47831, hostOnlyNames: ["studio.example.ts.net"] })).toBe(false)
  })

  it("drops only the default port of the listener's own scheme", () => {
    expect(canonicalAuthority("studio.example.ts.net:443", "https")).toBe("studio.example.ts.net")
    expect(canonicalAuthority("studio.example.ts.net", "https")).toBe("studio.example.ts.net")
    expect(canonicalAuthority("studio.example.ts.net:80", "http")).toBe("studio.example.ts.net")
    expect(canonicalAuthority("studio.example.ts.net:443", "http")).toBe("studio.example.ts.net:443")
    expect(answers("127.0.0.1", { scheme: "http", host: "127.0.0.1", port: 80 })).toBe(true)
    expect(answers("studio.example.ts.net", { scheme: "https", host: "100.64.0.1", port: 443, hostOnlyNames: ["studio.example.ts.net"] })).toBe(true)
    expect(answers("studio.example.ts.net", { scheme: "https", host: "100.64.0.1", port: 47831, hostOnlyNames: ["studio.example.ts.net"] })).toBe(false)
  })

  it("brackets and compresses IPv6 and refuses an unbracketed one", () => {
    expect(canonicalAuthority("[::1]:47831", "http")).toBe("[::1]:47831")
    expect(canonicalAuthority("[0:0:0:0:0:0:0:1]:47831", "http")).toBe("[::1]:47831")
    expect(canonicalAuthority("::1:47831", "http")).toBeUndefined()
    expect(answers("[::1]:47831", { scheme: "http", host: "::1", port: 47831 })).toBe(true)
    expect(answers("localhost:47831", { scheme: "http", host: "::1", port: 47831 })).toBe(true)
  })

  it("refuses userinfo, a path, a query, a fragment and anything but a plain authority", () => {
    for (const host of [
      "user@studio.example.ts.net:47831", "studio.example.ts.net:47831/path", "studio.example.ts.net:47831?query",
      "studio.example.ts.net:47831#fragment", "studio.example.ts.net\\@evil.example:47831", " studio.example.ts.net:47831",
      "studio.example.ts.net:", "studio.example.ts.net:99999",
    ]) expect(canonicalAuthority(host, "https"), host).toBeUndefined()
  })

  it("refuses an empty or missing Host", () => {
    expect(canonicalAuthority("", "https")).toBeUndefined()
    expect(canonicalAuthority(undefined, "https")).toBeUndefined()
    expect(answers("", { scheme: "http", host: "127.0.0.1", port: 47831 })).toBe(false)
  })

  // Codex review round 1 (Minor): a wildcard bind is no name a client dials,
  // however the bind address is spelled.
  it("answers no wildcard address, however the bind is spelled", () => {
    for (const host of ["0.0.0.0", "0", "0x0", "0.0", "::", "[::]", "::0", "0:0:0:0:0:0:0:0", "[0:0:0:0:0:0:0:0]"]) {
      const facts = { scheme: "https", host, port: 47831 } as const
      for (const authority of ["0.0.0.0:47831", "0:47831", "[::]:47831", "[0:0:0:0:0:0:0:0]:47831"]) {
        expect(answers(authority, facts), `${host} ${authority}`).toBe(false)
      }
    }
    expect(answers("100.64.0.1:47831", { scheme: "https", host: "100.64.0.1", port: 47831 })).toBe(true)
  })

  it("answers only the listener's own names and port", () => {
    const loopback = { scheme: "http", host: "127.0.0.1", port: 47831 } as const
    expect(answers("127.0.0.1:47831", loopback)).toBe(true)
    expect(answers("localhost:47831", loopback)).toBe(true)
    expect(answers("localhost:47832", loopback)).toBe(false)
    expect(answers("localhost", loopback)).toBe(false)
    expect(answers("127.0.0.2:47831", loopback)).toBe(false)
    expect(answers("attacker.example:47831", loopback)).toBe(false)
  })
})
