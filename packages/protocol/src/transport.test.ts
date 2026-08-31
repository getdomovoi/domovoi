import { describe, expect, it } from "vitest"

import {
  orderedTransports,
  selectTransport,
  transportCandidateSchema,
  transportPreference,
} from "./transport.js"

const loopback = { kind: "local" as const, endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true as const }
const lan = { kind: "lan" as const, endpoint: "wss://workshop.local:47831/rpc", authenticated: true as const }
const tailnet = { kind: "tailnet" as const, endpoint: "wss://workshop.tailnet:47831/rpc", authenticated: true as const }
const ssh = {
  kind: "ssh" as const,
  endpoint: "wss://127.0.0.1:47999/rpc",
  authenticated: true as const,
  configured: true,
}
const relay = { kind: "relay" as const, endpoint: "wss://relay.domovoi.sh/rpc", authenticated: true as const }

describe("transportCandidateSchema", () => {
  it("describes a candidate transport", () => {
    expect(transportCandidateSchema.parse(loopback)).toEqual(loopback)
  })

  it("refuses an unauthenticated transport, including inside a tailnet", () => {
    for (const candidate of [loopback, lan, tailnet, ssh, relay]) {
      expect(transportCandidateSchema.safeParse({ ...candidate, authenticated: false }).success)
        .toBe(false)
    }
  })

  it("rejects an endpoint that is not a WebSocket URL", () => {
    expect(transportCandidateSchema.safeParse({ ...lan, endpoint: "https://workshop.local" }).success)
      .toBe(false)
  })

  it("rejects an unknown transport kind", () => {
    expect(transportCandidateSchema.safeParse({ ...lan, kind: "carrier-pigeon" }).success).toBe(false)
  })
})

describe("orderedTransports", () => {
  it("prefers private transports in the documented order", () => {
    expect(orderedTransports([relay, ssh, tailnet, lan, loopback]).map((candidate) => candidate.kind))
      .toEqual(["local", "lan", "tailnet", "ssh", "relay"])
  })

  it("treats WSL as a private local transport", () => {
    const wsl = { kind: "wsl" as const, endpoint: "ws://127.0.0.1:47832/rpc", authenticated: true as const }
    expect(orderedTransports([relay, wsl]).map((candidate) => candidate.kind)).toEqual(["wsl", "relay"])
  })

  it("documents the preference order it applies", () => {
    expect(transportPreference).toEqual(["local", "wsl", "lan", "tailnet", "ssh", "relay"])
  })
})

describe("selectTransport", () => {
  it("chooses the most private usable transport", () => {
    expect(selectTransport([relay, tailnet, loopback])).toEqual(loopback)
  })

  it("falls back to the next transport when a closer one is unavailable", () => {
    expect(selectTransport([relay, tailnet])).toEqual(tailnet)
  })

  it("uses an SSH tunnel only where it was explicitly configured", () => {
    expect(selectTransport([{ ...ssh, configured: false }, relay])).toEqual(relay)
    expect(selectTransport([ssh, relay])).toEqual(ssh)
  })

  it("refuses the relay until a hosted relay exists", () => {
    expect(selectTransport([relay], { relayAvailable: false })).toBeUndefined()
  })

  it("has nothing to choose when no candidate is usable", () => {
    expect(selectTransport([])).toBeUndefined()
  })

  it("never selects an undescribable candidate", () => {
    expect(() => selectTransport([{ ...lan, authenticated: false } as never])).toThrow()
  })
})
