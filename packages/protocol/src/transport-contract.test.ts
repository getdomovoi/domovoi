import { describe, expect, it } from "vitest"
import { z } from "zod"

import { orderedTransports, selectTransport, transportCandidateSchema } from "./transport.js"

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
})
