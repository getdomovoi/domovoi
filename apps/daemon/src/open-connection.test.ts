import { describe, expect, it, vi } from "vitest"

import { connectionForTarget, type OpenConnectionDependencies } from "./open-connection.js"
import { readDistroEndpoint } from "./wsl-endpoint.js"

const localToken = "local-daemon-token"
const distroToken = "distro-daemon-token"

function dependencies(overrides: Partial<OpenConnectionDependencies> = {}) {
  const base: OpenConnectionDependencies = {
    local: async () => ({ host: "127.0.0.1", port: 47831, token: localToken }),
    endpoint: async () => ({ host: "127.0.0.1", port: 47900, token: distroToken }),
    ...overrides,
  }
  return base
}

describe("connectionForTarget", () => {
  it("uses this machine's daemon for a path on this machine", async () => {
    const connection = await connectionForTarget(
      { kind: "windows", path: "C:\\Users\\me\\project" },
      dependencies(),
    )
    expect(connection).toEqual({ host: "127.0.0.1", port: 47831, token: localToken })
  })

  it("uses the daemon inside the distribution for a path inside it", async () => {
    const connection = await connectionForTarget(
      { kind: "wsl", distribution: "debian", path: "/srv/app" },
      dependencies(),
    )
    expect(connection).toEqual({ host: "127.0.0.1", port: 47900, token: distroToken })
  })

  it("never sends this machine's credential to a distribution", async () => {
    const connection = await connectionForTarget(
      { kind: "wsl", distribution: "debian", path: "/srv/app" },
      dependencies(),
    )
    expect(connection.token).not.toBe(localToken)
  })

  it("asks only the distribution that holds the work", async () => {
    const endpoint = vi.fn<OpenConnectionDependencies["endpoint"]>(async () => ({
      host: "127.0.0.1",
      port: 47900,
      token: distroToken,
    }))
    await connectionForTarget({ kind: "wsl", distribution: "debian", path: "/srv/app" }, dependencies({ endpoint }))
    expect(endpoint).toHaveBeenCalledWith("debian")
  })

  it("does not read this machine's credential for work inside a distribution", async () => {
    const local = vi.fn<OpenConnectionDependencies["local"]>(async () => ({
      host: "127.0.0.1",
      port: 47831,
      token: localToken,
    }))
    await connectionForTarget({ kind: "wsl", distribution: "debian", path: "/srv/app" }, dependencies({ local }))
    expect(local).not.toHaveBeenCalled()
  })

  it("says which distribution has no daemon, and how to start one, rather than opening anything", async () => {
    await expect(connectionForTarget(
      { kind: "wsl", distribution: "debian", path: "/srv/app" },
      dependencies({ endpoint: async () => undefined }),
    )).rejects.toThrow(/no daemon is running in debian.*wsl\.exe -d debian.*domovoid/s)
  })

  it("never repeats a credential in the error it raises", async () => {
    await expect(connectionForTarget(
      { kind: "wsl", distribution: "debian", path: "/srv/app" },
      dependencies({ endpoint: async () => undefined }),
    )).rejects.toThrow(expect.objectContaining({
      message: expect.not.stringContaining(distroToken),
    }))
  })

  it("carries a tls listener setting through for this machine", async () => {
    const connection = await connectionForTarget({ kind: "windows", path: "C:\\p" }, dependencies({
      local: async () => ({ host: "127.0.0.1", port: 47831, token: localToken, tls: true }),
    }))
    expect(connection).toMatchObject({ tls: true })
  })

  it("does not call a torn endpoint file a missing daemon, and repeats none of it", async () => {
    const torn = JSON.stringify({ host: "127.0.0.1", port: 47900, token: distroToken }).slice(0, -5)
    const refused = connectionForTarget(
      { kind: "wsl", distribution: "debian", path: "/srv/app" },
      dependencies({ endpoint: (distribution) => readDistroEndpoint({ distribution, run: async () => torn }) }),
    )
    await expect(refused).rejects.toThrow(/endpoint file in debian.*domovoid/s)
    await expect(refused).rejects.not.toThrow(/no daemon is running/)
    await expect(refused).rejects.toThrow(expect.objectContaining({
      message: expect.not.stringContaining(distroToken.slice(0, 8)),
    }))
  })

  it("reports a distribution that could not be asked at all", async () => {
    await expect(connectionForTarget(
      { kind: "wsl", distribution: "debian", path: "/srv/app" },
      dependencies({
        endpoint: async () => {
          throw new Error("There is no distribution with the supplied name.")
        },
      }),
    )).rejects.toThrow(/no distribution/)
  })
})
