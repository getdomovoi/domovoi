import { describe, expect, it } from "vitest"
import { z } from "zod"

import { connectionKindSchema } from "./schema.js"
import {
  directTransportEndpointSchema,
  orderedTransports,
  selectTransport,
  transportCandidateSchema,
  transportContract,
  transportPreference,
  usableTransports,
} from "./transport.js"

const candidate = (kind: string, endpoint: string) => ({ kind, endpoint, authenticated: true })

describe("transport kind contract", () => {
  it("is a discriminated union rather than independent kind and endpoint fields", () => {
    expect(transportCandidateSchema).toBeInstanceOf(z.ZodDiscriminatedUnion)
  })

  it.each(["local", "wsl", "ssh"])("cannot give a remote endpoint %s priority", (kind) => {
    const remote = { ...candidate(kind, "wss://remote.example/rpc"), ...(kind === "ssh" ? { configured: true } : {}) }
    expect(transportCandidateSchema.safeParse(remote).success).toBe(false)
    expect(() => orderedTransports([remote as never])).toThrow()
  })

  it.each(["lan", "tailnet"])("requires a protected non-loopback %s endpoint", (kind) => {
    for (const endpoint of ["ws://remote.example/rpc", "ws://127.0.0.1/rpc", "wss://localhost/rpc",
      "wss://0.0.0.0/rpc", "wss://[::]/rpc"]) {
      expect(transportCandidateSchema.safeParse(candidate(kind, endpoint)).success, endpoint).toBe(false)
    }
  })

  it.each(["local", "wsl", "lan", "tailnet", "relay"])("does not accept SSH configuration on %s", (kind) => {
    const endpoint = kind === "local" || kind === "wsl" ? "ws://127.0.0.1/rpc" : "wss://remote.example/rpc"
    for (const configured of [false, true]) {
      const value = { ...candidate(kind, endpoint), configured }
      expect(transportCandidateSchema.safeParse(value).success).toBe(false)
      expect(() => selectTransport([value as never])).toThrow()
    }
  })

  it("requires SSH configuration to be stated, not guessed by a consumer", () => {
    expect(transportCandidateSchema.safeParse(candidate("ssh", "ws://127.0.0.1/rpc")).success).toBe(false)
  })

  it.each(["127%2e0%2e0%2e1", "[0:0:0:0:0:0:0:1]", "localhost"])("accepts normalized loopback %s", (host) => {
    for (const kind of ["local", "wsl", "ssh"]) {
      const value = { ...candidate(kind, `ws://${host}:47831/rpc`), ...(kind === "ssh" ? { configured: true } : {}) }
      expect(transportCandidateSchema.parse(value)).toEqual(value)
    }
  })

  it.each(["[::ffff:127.0.0.1]", "127.0.0.1%2eexample.com", "127.0.0.1.example.com"])("refuses unsupported loopback spelling %s", (host) => {
    expect(transportCandidateSchema.safeParse(candidate("local", `ws://${host}/rpc`)).success).toBe(false)
  })

  it.each([
    ["credentials", "wss://user:secret@remote.example/rpc"],
    ["query", "wss://remote.example/rpc?token=secret"],
    ["fragment", "wss://remote.example/rpc#secret"],
    ["oversized", `wss://remote.example/${"x".repeat(2048)}`],
  ])("refuses an unsafe or oversized endpoint: %s", (_label, endpoint) => {
    expect(transportCandidateSchema.safeParse(candidate("lan", endpoint)).success).toBe(false)
  })

  it("cannot enable the reserved relay by claiming it is available", () => {
    const relay = { kind: "relay" as const, endpoint: "wss://relay.example/rpc", authenticated: true as const }
    for (const options of [{}, { relayAvailable: true }, { relayAvailable: false }]) {
      expect(selectTransport([relay], options)).toBeUndefined()
    }
  })

  it("defines capability, protection, configuration and availability for every variant", () => {
    expect(Object.keys(transportContract).sort()).toEqual([...connectionKindSchema.options].sort())
    expect(transportCandidateSchema.options.map((option) => option.shape.kind.value).sort())
      .toEqual([...connectionKindSchema.options].sort())
    expect([...transportPreference].sort()).toEqual([...connectionKindSchema.options].sort())
    for (const kind of ["local", "wsl", "lan", "tailnet", "ssh"] as const) {
      expect(transportContract[kind].capabilities).toEqual(["rpc", "terminals", "previews"])
      expect(transportContract[kind].locality).toBe(kind === "lan" || kind === "tailnet" ? "remote" : "loopback")
      expect(transportContract[kind].protection).toBe(kind === "lan" || kind === "tailnet" ? "tls" : "loopback-or-tls")
      expect(transportContract[kind].configuration).toBe(kind === "ssh" ? "explicit" : "none")
      expect(transportContract[kind].availability).toBe(kind === "ssh" ? "when-configured" : "candidate")
    }
    expect(transportContract.relay).toEqual({ locality: "remote", protection: "encrypted-channel-required",
      configuration: "unsupported", availability: "unavailable", capabilities: [] })
  })

  it("cannot override policy using fields supplied by a peer", () => {
    for (const override of [{ availability: "candidate" }, { capabilities: ["rpc", "previews"] }, { protection: "tls" }]) {
      expect(transportCandidateSchema.safeParse({ ...candidate("relay", "wss://relay.example/rpc"), ...override }).success).toBe(false)
    }
  })

  it("keeps display ordering separate from dial eligibility without losing stable fallback order", () => {
    const available = transportCandidateSchema.parse({ ...candidate("ssh", "ws://127.0.0.1:1/rpc"), configured: true })
    const unavailable = { ...available, configured: false }
    const first = transportCandidateSchema.parse(candidate("lan", "wss://first.example/rpc"))
    const second = transportCandidateSchema.parse(candidate("lan", "wss://second.example/rpc"))
    const relay = transportCandidateSchema.parse(candidate("relay", "wss://relay.example/rpc"))
    const values = [relay, unavailable, available, first, second]
    expect(orderedTransports(values)).toEqual([first, second, unavailable, available, relay])
    expect(usableTransports(values)).toEqual([first, second, available])
    expect(values).toEqual([relay, unavailable, available, first, second])
  })

  it.each(["not a url", "https://remote.example/rpc", "ftp://127.0.0.1/rpc", "ws://remote.example/rpc"])(
    "refuses an invalid or unprotected direct endpoint: %s", (endpoint) => {
      expect(directTransportEndpointSchema.safeParse(endpoint).success).toBe(false)
      expect(transportCandidateSchema.safeParse(candidate("lan", endpoint)).success).toBe(false)
    },
  )
})
