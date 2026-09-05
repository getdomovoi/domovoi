import { describe, expect, it } from "vitest"

import { transportCandidateSchema } from "@getdomovoi/protocol"

import { advertisedTransports } from "./advertised-transports.js"

describe("advertisedTransports", () => {
  it("produces an explicitly configured tailnet route after LAN, using the bound port", () => {
    const input = { host: "0.0.0.0", port: 49123, tls: true,
      advertiseHost: "studio.lan", tailnetHost: "studio.tailnet.example" }
    expect(advertisedTransports(input)).toEqual([
      { kind: "lan", endpoint: "wss://studio.lan:49123/rpc", authenticated: true },
      { kind: "tailnet", endpoint: "wss://studio.tailnet.example:49123/rpc", authenticated: true },
    ])
  })

  it("produces a tailnet-only route for a wildcard listener without a LAN name", () => {
    const input = { host: "::", port: 47831, tls: true, tailnetHost: "fd7a:115c:a1e0::7" }
    expect(advertisedTransports(input)).toEqual([
      { kind: "tailnet", endpoint: "wss://[fd7a:115c:a1e0::7]:47831/rpc", authenticated: true },
    ])
  })

  it("reports TLS for an encrypted loopback listener too", () => {
    expect(advertisedTransports({ host: "127.0.0.1", port: 47831, tls: true })).toEqual([
      { kind: "local", endpoint: "wss://127.0.0.1:47831/rpc", authenticated: true },
    ])
  })

  it("advertises the loopback listener a local client can reach", () => {
    expect(advertisedTransports({ host: "127.0.0.1", port: 47831 })).toEqual([
      { kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true },
    ])
  })

  it("advertises an encrypted listener under the name it is reachable by", () => {
    expect(advertisedTransports({
      host: "0.0.0.0",
      port: 47831,
      tls: true,
      advertiseHost: "workshop.tailnet",
    })).toEqual([
      { kind: "lan", endpoint: "wss://workshop.tailnet:47831/rpc", authenticated: true },
    ])
  })

  it("never advertises an unencrypted endpoint off loopback", () => {
    expect(advertisedTransports({
      host: "0.0.0.0",
      port: 47831,
      advertiseHost: "workshop.tailnet",
    })).toEqual([])
  })

  it("never advertises a wildcard address, which nothing can dial", () => {
    for (const host of ["0.0.0.0", "::"]) {
      expect(advertisedTransports({ host, port: 47831, tls: true })).toEqual([])
    }
  })

  it("advertises nothing remote without a name to advertise", () => {
    expect(advertisedTransports({ host: "0.0.0.0", port: 47831, tls: true })).toEqual([])
  })

  it("advertises a concrete encrypted host without needing a separate name", () => {
    expect(advertisedTransports({ host: "workshop.local", port: 47831, tls: true })).toEqual([
      { kind: "lan", endpoint: "wss://workshop.local:47831/rpc", authenticated: true },
    ])
  })

  it("brackets an IPv6 host so the endpoint parses", () => {
    expect(advertisedTransports({
      host: "0.0.0.0",
      port: 47831,
      tls: true,
      advertiseHost: "fd7a:115c:a1e0::1",
    })[0]?.endpoint).toBe("wss://[fd7a:115c:a1e0::1]:47831/rpc")
  })

  it("only advertises candidates the protocol accepts", () => {
    const advertised = [
      ...advertisedTransports({ host: "127.0.0.1", port: 47831 }),
      ...advertisedTransports({ host: "workshop.local", port: 47831, tls: true }),
    ]

    expect(advertised).toHaveLength(2)
    for (const candidate of advertised) {
      expect(transportCandidateSchema.parse(candidate)).toEqual(candidate)
    }
  })
})
