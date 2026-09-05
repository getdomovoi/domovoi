import { describe, expect, it, vi } from "vitest"

import { waitForDaemon } from "./test-wait-for.js"
import { discoverWslMachines, wslDaemonEndpointUrl, type WslDiscoveryInput } from "./wsl-discovery.js"
import type { WslDistribution } from "./wsl-distributions.js"

const token = "distro-daemon-token"
const listing: WslDistribution[] = [
  { name: "Ubuntu-24.04", state: "Running", version: 2, default: true },
  { name: "parked", state: "Stopped", version: 2, default: false },
  { name: "Legacy", state: "Running", version: 1, default: false },
]

function discovery(overrides: Partial<WslDiscoveryInput> = {}) {
  const base = {
    platform: "win32" as const,
    distributions: vi.fn<NonNullable<WslDiscoveryInput["distributions"]>>(async () => listing),
    endpoint: vi.fn<NonNullable<WslDiscoveryInput["endpoint"]>>(async (distribution) =>
      distribution === "Ubuntu-24.04" ? { host: "127.0.0.1", port: 47_832, token } : undefined),
  }
  return Object.assign(base, overrides) as typeof base
}

describe("discoverWslMachines", () => {
  it("reports every distribution with its version, state, and whether a daemon answers", async () => {
    await expect(discoverWslMachines(discovery())).resolves.toEqual([
      {
        distribution: "Ubuntu-24.04", version: 2, state: "running", default: true,
        daemon: "present", endpoint: "ws://127.0.0.1:47832/rpc",
      },
      { distribution: "parked", version: 2, state: "stopped", default: false, daemon: "absent" },
      { distribution: "Legacy", version: 1, state: "running", default: false, daemon: "absent" },
    ])
  })

  it("names the loopback endpoint WSL forwards, and never the credential", async () => {
    const facts = await discoverWslMachines(discovery())
    expect(JSON.stringify(facts)).not.toContain(token)
  })

  it("writes an IPv6 loopback endpoint the way a dialer needs it", async () => {
    const input = discovery({ endpoint: vi.fn(async () => ({ host: "::1", port: 47_900, token })) })
    const [ubuntu] = await discoverWslMachines(input)
    expect(ubuntu).toMatchObject({ endpoint: "ws://[::1]:47900/rpc" })
  })

  it("does not ask a stopped distribution, which would start it", async () => {
    const input = discovery()
    await discoverWslMachines(input)
    expect(input.endpoint.mock.calls.map(([distribution]) => distribution)).toEqual(["Ubuntu-24.04", "Legacy"])
  })

  it("reports a running distribution that published no endpoint as having no daemon", async () => {
    const input = discovery({ endpoint: vi.fn(async () => undefined) })
    const [ubuntu] = await discoverWslMachines(input)
    expect(ubuntu).toMatchObject({ daemon: "absent" })
    expect(ubuntu).not.toHaveProperty("endpoint")
  })

  it("says when a running distribution could not be asked, rather than calling that absence", async () => {
    const input = discovery({
      endpoint: vi.fn(async () => {
        throw new Error("wsl.exe did not answer in time")
      }),
    })
    const [ubuntu] = await discoverWslMachines(input)
    expect(ubuntu).toMatchObject({ daemon: "unknown" })
  })

  it("asks the running distributions together rather than one deadline after another", async () => {
    let release!: () => void
    const held = new Promise<undefined>((resolve) => {
      release = () => resolve(undefined)
    })
    const input = discovery({ endpoint: vi.fn(() => held) })
    const discovering = discoverWslMachines(input)
    await waitForDaemon(() => expect(input.endpoint).toHaveBeenCalledTimes(2))
    release()
    await discovering
  })

  it("reports nothing off Windows without asking anything", async () => {
    const input = discovery({ platform: "linux" })
    await expect(discoverWslMachines(input)).resolves.toEqual([])
    expect(input.distributions).not.toHaveBeenCalled()
    expect(input.endpoint).not.toHaveBeenCalled()
  })
})

describe("wslDaemonEndpointUrl", () => {
  it("writes a WebSocket URL for the forwarded loopback port", () => {
    expect(wslDaemonEndpointUrl({ host: "127.0.0.1", port: 47_831 })).toBe("ws://127.0.0.1:47831/rpc")
    expect(wslDaemonEndpointUrl({ host: "localhost", port: 47_831 })).toBe("ws://localhost:47831/rpc")
    expect(wslDaemonEndpointUrl({ host: "::1", port: 47_831 })).toBe("ws://[::1]:47831/rpc")
  })
})
