import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"

import { realDevEndpoint } from "./dev-real-endpoint.mjs"

const token = "b".repeat(43)

describe("realDevEndpoint", () => {
  it("exposes the documented command from the desktop package directory", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(manifest.scripts["dev:desktop:real"]).toBe("pnpm dev:real")
  })

  it("discovers the loopback port but reads authentication from daemon.token", () => {
    const readFile = vi.fn((path) => path.endsWith("endpoint.json")
      ? JSON.stringify({ host: "127.0.0.1", port: 48123, token: "ignored-endpoint-token" })
      : `${token}\n`)
    expect(realDevEndpoint({ homeDirectory: "/Users/dev", environment: {}, readFile })).toEqual({
      url: "ws://127.0.0.1:48123/rpc",
      token,
    })
    expect(readFile).toHaveBeenCalledWith("/Users/dev/.domovoi/daemon.token", "utf8")
  })

  it("accepts an explicit loopback URL for a daemon on another port", () => {
    expect(realDevEndpoint({
      homeDirectory: "/Users/dev",
      environment: { DOMOVOI_DEV_DAEMON_URL: "ws://localhost:49000/rpc" },
      readFile: (path) => path.endsWith("daemon.token") ? token : "unused",
    })).toEqual({ url: "ws://localhost:49000/rpc", token })
  })

  it("reads a separately configured daemon profile", () => {
    const readFile = vi.fn((path) => path.endsWith("endpoint.json")
      ? JSON.stringify({ host: "localhost", port: 49001 })
      : token)
    expect(realDevEndpoint({
      homeDirectory: "/Users/dev",
      environment: { DOMOVOI_PROFILE_DIR: "/private/tmp/domovoi-dev-profile" },
      readFile,
    })).toEqual({ url: "ws://localhost:49001/rpc", token })
    expect(readFile).toHaveBeenCalledWith("/private/tmp/domovoi-dev-profile/daemon.token", "utf8")
  })

  it("explains how to start a daemon when the selected profile has no published endpoint", () => {
    expect(() => realDevEndpoint({
      homeDirectory: "/Users/dev",
      environment: {},
      readFile: (path) => {
        if (path.endsWith("daemon.token")) return token
        throw Object.assign(new Error("missing"), { code: "ENOENT" })
      },
    })).toThrow(/No running daemon published .*endpoint\.json.*pnpm --filter @getdomovoi\/daemon start/su)
  })

  it.each([
    ["a remote endpoint", JSON.stringify({ host: "example.test", port: 47831 })],
    ["an invalid port", JSON.stringify({ host: "127.0.0.1", port: 0 })],
    ["an invalid token", JSON.stringify({ host: "127.0.0.1", port: 47831 })],
  ])("refuses %s", (_label, endpoint) => {
    expect(() => realDevEndpoint({
      homeDirectory: "/Users/dev",
      environment: {},
      readFile: (path) => path.endsWith("endpoint.json") ? endpoint : "short",
    })).toThrow()
  })
})
