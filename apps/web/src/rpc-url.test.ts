import { describe, expect, it } from "vitest"

import { rpcUrlFor } from "./rpc-url"

const daemonOverTailnet = { protocol: "https:", host: "studio.example.ts.net:47831" }
const daemonOnLoopback = { protocol: "http:", host: "127.0.0.1:47831" }

describe("the rpc URL", () => {
  it("is the page's own origin over wss when the daemon serves the page over https", () => {
    expect(rpcUrlFor({ override: undefined, dev: false, location: daemonOverTailnet })).toBe("wss://studio.example.ts.net:47831/rpc")
    expect(rpcUrlFor({ override: undefined, dev: false, location: { protocol: "https:", host: "studio.example.ts.net" } })).toBe("wss://studio.example.ts.net/rpc")
  })

  it("is the page's own origin over ws when the daemon serves the page over http", () => {
    expect(rpcUrlFor({ override: undefined, dev: false, location: daemonOnLoopback })).toBe("ws://127.0.0.1:47831/rpc")
    expect(rpcUrlFor({ override: undefined, dev: false, location: { protocol: "http:", host: "[::1]:47831" } })).toBe("ws://[::1]:47831/rpc")
  })

  it("is the VITE_DOMOVOI_RPC_URL override whenever one is set", () => {
    const override = "wss://other.example.ts.net:47900/rpc"
    expect(rpcUrlFor({ override, dev: false, location: daemonOverTailnet })).toBe(override)
    expect(rpcUrlFor({ override, dev: true, location: { protocol: "http:", host: "127.0.0.1:5178" } })).toBe(override)
  })

  it("keeps the local daemon's default on the dev server, which is not the daemon", () => {
    expect(rpcUrlFor({ override: undefined, dev: true, location: { protocol: "http:", host: "127.0.0.1:5178" } })).toBe("ws://127.0.0.1:47831/rpc")
  })

  it("reads an empty override as unset", () => {
    expect(rpcUrlFor({ override: "", dev: false, location: daemonOverTailnet })).toBe("wss://studio.example.ts.net:47831/rpc")
    expect(rpcUrlFor({ override: "", dev: true, location: daemonOnLoopback })).toBe("ws://127.0.0.1:47831/rpc")
  })

  it("keeps the local daemon's default for a page no daemon served, such as a file", () => {
    expect(rpcUrlFor({ override: undefined, dev: false, location: { protocol: "file:", host: "" } })).toBe("ws://127.0.0.1:47831/rpc")
  })
})
