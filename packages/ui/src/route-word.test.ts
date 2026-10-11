import { describe, expect, it } from "vitest"

import { machineRoute, routeOfEndpoint } from "./route-word"

describe("routeOfEndpoint", () => {
  it.each([
    "ws://127.0.0.1:47831/rpc",
    "ws://localhost:47831/rpc",
    "ws://[::1]:47831/rpc",
    "ws://127.0.0.2:47831/rpc",
    "ws://localhost.:47831/rpc",
    "ws://LOCALHOST:47831/rpc",
    "ws://[::ffff:127.0.0.1]:47831/rpc",
    "wss://[::ffff:127.0.0.1]:47831/rpc",
    "http://127.0.0.1:47831/",
  ])("reads %s as loopback", (url) => {
    expect(routeOfEndpoint(url)).toBe("loopback")
  })

  it.each([
    "wss://studio.example.ts.net:47831/rpc",
    "wss://studio.example.ts.net.:47831/rpc",
    "wss://100.64.0.1:47831/rpc",
    "wss://100.101.102.103:47831/rpc",
    "wss://100.127.255.254:47831/rpc",
    "wss://[fd7a:115c:a1e0::1]:47831/rpc",
    "wss://[fd7a:115c:a1e0:ab12:4843:cd96:6258:b240]:47831/rpc",
  ])("reads %s as the tailnet", (url) => {
    expect(routeOfEndpoint(url)).toBe("tailnet")
  })

  // A name or address that is not provably loopback or Tailscale's is a
  // direct connection to some host: neither "local" nor "tailnet".
  it.each([
    "wss://studio.corp.example:47831/rpc",
    "wss://192.168.1.20:47831/rpc",
    "wss://100.63.255.255:47831/rpc",
    "wss://100.128.0.1:47831/rpc",
    "wss://[fd7a:115c:a1e1::1]:47831/rpc",
    "wss://ts.net.evil.example:47831/rpc",
    "wss://evilts.net:47831/rpc",
    "wss://ts.net:47831/rpc",
  ])("reads %s as a direct route", (url) => {
    expect(routeOfEndpoint(url)).toBe("direct")
  })

  // The daemon refuses a plaintext listener off loopback, so a client should
  // never hold one. If it does, the word says so rather than calling it direct
  // or the tailnet, both of which read as a protected route.
  it.each([
    "ws://192.168.1.20:47831/rpc",
    "ws://studio.example.ts.net:47831/rpc",
    "ws://100.101.102.103:47831/rpc",
    "http://studio.corp.example:47831/rpc",
  ])("reads %s as plaintext", (url) => {
    expect(routeOfEndpoint(url)).toBe("plaintext")
  })

  // Only ws, wss, http and https say anything about TLS. Any other scheme
  // proves nothing, so it never earns a protected word.
  it.each([
    "not a url",
    "ftp://studio.example.ts.net/rpc",
    "file:///tmp/rpc",
    "ftp://localhost/rpc",
  ])("does not guess a route it cannot read: %s", (url) => {
    expect(routeOfEndpoint(url)).toBe("unknown")
  })
})

describe("machineRoute", () => {
  it("names the route of the endpoint this client dialed", () => {
    expect(machineRoute("ws://127.0.0.1:47831/rpc")).toBe("loopback")
    expect(machineRoute("ws://127.0.0.1:47831/rpc", "local")).toBe("loopback")
    expect(machineRoute("wss://studio.example.ts.net:47831/rpc", "tailnet")).toBe("tailnet")
  })

  // tailnet and lan are the operator's classification of a candidate, not
  // proof of the network: the endpoint still has to show it.
  it("does not take a candidate's kind as proof of the tailnet", () => {
    expect(machineRoute("wss://studio.corp.example:47831/rpc", "tailnet")).toBe("direct")
    expect(machineRoute("wss://192.168.1.20:47831/rpc", "lan")).toBe("direct")
  })

  // A forwarded port is a loopback socket to another machine: the hop is
  // loopback, the route is the SSH tunnel or the WSL guest behind it.
  it("names an SSH forward and a WSL guest rather than calling them loopback", () => {
    expect(machineRoute("ws://127.0.0.1:52011/rpc", "ssh")).toBe("ssh")
    expect(machineRoute("ws://127.0.0.1:52012/rpc", "wsl")).toBe("wsl")
  })
})
