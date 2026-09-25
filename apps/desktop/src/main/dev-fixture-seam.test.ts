import { describe, expect, it } from "vitest"

import { rpcMethods } from "@getdomovoi/protocol"

import {
  devDaemonTokenVariable,
  devDaemonUrlVariable,
  devFixtureEndpoint,
  devFixtureUrlVariable,
  devLoopEndpoint,
  resolveDesktopDaemonSeam,
  shouldRequireSingleInstanceLock,
} from "./dev-fixture-seam.js"

const fixtureUrl = "ws://127.0.0.1:47999/rpc"
const daemonUrl = "ws://localhost:47831/rpc"
const daemonToken = "a".repeat(43)

const realSeam = () => Promise.reject(new Error("the real seam ran"))

describe("the development fixture seam", () => {
  it("refuses a packaged build even when the variable names a valid fixture", () => {
    const environment = { [devFixtureUrlVariable]: fixtureUrl }
    expect(devFixtureEndpoint({ isPackaged: true, environment })).toBeNull()
    expect(resolveDesktopDaemonSeam({ isPackaged: true, environment, acquire: realSeam })).toBe(realSeam)
  })

  it("returns the real seam when the variable is absent", () => {
    const options = { isPackaged: false, environment: {}, acquire: realSeam }
    expect(resolveDesktopDaemonSeam(options)).toBe(realSeam)
  })

  it.each([
    ["a remote host", "ws://198.51.100.4:47999/rpc"],
    ["a non-loopback name", "ws://fixture.example/rpc"],
    ["an http url", "http://127.0.0.1:47999/rpc"],
    ["credentials in the url", "ws://user:secret@127.0.0.1:47999/rpc"],
    ["nonsense", "not-a-url"],
  ])("refuses %s", (_label, url) => {
    const environment = { [devFixtureUrlVariable]: url }
    expect(devFixtureEndpoint({ isPackaged: false, environment })).toBeNull()
  })

  it("owns the fixture endpoint in an unpackaged build", async () => {
    const environment = { [devFixtureUrlVariable]: fixtureUrl }
    const seam = resolveDesktopDaemonSeam({ isPackaged: false, environment, acquire: realSeam })
    const handle = await seam({ mode: "start-or-attach", timeoutMs: 1_000 })
    expect(handle.kind).toBe("owned")
    expect(handle.kind === "owned" && handle.endpoint.url).toBe(fixtureUrl)
  })

  // The window sent its token to the fixture and the fixture refused it: the
  // protocol requires 43 base64url characters. The handshake schema checks the
  // token here so the loop cannot ship a token the daemon would reject.
  it("carries a token the protocol's own handshake accepts", () => {
    const endpoint = devFixtureEndpoint({
      isPackaged: false,
      environment: { [devFixtureUrlVariable]: fixtureUrl },
    })
    expect(endpoint).not.toBeNull()
    const parsed = rpcMethods["system.hello"].params.safeParse({
      client: "desktop",
      clientVersion: "0.0.0",
      authToken: endpoint?.token,
    })
    expect(parsed.success).toBe(true)
  })
})

describe("the real daemon development seam", () => {
  const environment = {
    [devDaemonUrlVariable]: daemonUrl,
    [devDaemonTokenVariable]: daemonToken,
  }

  it("attaches an unpackaged window to a loopback daemon without owning it", async () => {
    expect(devLoopEndpoint({ isPackaged: false, environment })).toEqual({
      kind: "daemon",
      endpoint: { url: daemonUrl, token: daemonToken },
    })
    const handle = await resolveDesktopDaemonSeam({ isPackaged: false, environment, acquire: realSeam })({
      mode: "start-or-attach",
      timeoutMs: 1_000,
    })
    expect(handle).toMatchObject({ kind: "attached", owner: "daemon", endpoint: { url: daemonUrl } })
  })

  it("accepts the IPv6 loopback URL endpoint discovery may publish", () => {
    expect(devLoopEndpoint({
      isPackaged: false,
      environment: {
        [devDaemonUrlVariable]: "ws://[::1]:47831/rpc",
        [devDaemonTokenVariable]: daemonToken,
      },
    })).toMatchObject({ kind: "daemon", endpoint: { url: "ws://[::1]:47831/rpc" } })
  })

  it.each([
    ["a packaged build", true, daemonUrl, daemonToken],
    ["a remote daemon", false, "ws://192.0.2.4:47831/rpc", daemonToken],
    ["an invalid token", false, daemonUrl, "short"],
  ])("refuses %s", (_label, isPackaged, url, token) => {
    expect(devLoopEndpoint({
      isPackaged,
      environment: { [devDaemonUrlVariable]: url, [devDaemonTokenVariable]: token },
    })).toBeNull()
  })

  it("refuses an ambiguous fixture and real daemon selection", () => {
    expect(devLoopEndpoint({
      isPackaged: false,
      environment: { ...environment, [devFixtureUrlVariable]: fixtureUrl },
    })).toBeNull()
  })
})

describe("shouldRequireSingleInstanceLock", () => {
  it("skips the lock for a fixture window", () => {
    expect(
      shouldRequireSingleInstanceLock({
        isPackaged: false,
        environment: { [devFixtureUrlVariable]: "ws://127.0.0.1:60872/rpc" },
      }),
    ).toBe(false)
  })

  it("skips the lock for the watched real-daemon window", () => {
    expect(shouldRequireSingleInstanceLock({
      isPackaged: false,
      environment: { [devDaemonUrlVariable]: daemonUrl, [devDaemonTokenVariable]: daemonToken },
    })).toBe(false)
  })

  it("keeps the lock for a packaged build even when the variable names a fixture", () => {
    expect(
      shouldRequireSingleInstanceLock({
        isPackaged: true,
        environment: { [devFixtureUrlVariable]: "ws://127.0.0.1:60872/rpc" },
      }),
    ).toBe(true)
  })

  it("keeps the lock for a development window with no fixture", () => {
    expect(
      shouldRequireSingleInstanceLock({ isPackaged: false, environment: {} }),
    ).toBe(true)
  })

  it("keeps the lock when the fixture URL is not loopback", () => {
    expect(
      shouldRequireSingleInstanceLock({
        isPackaged: false,
        environment: { [devFixtureUrlVariable]: "ws://10.0.0.5:60872/rpc" },
      }),
    ).toBe(true)
  })
})
