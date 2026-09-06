import { afterEach, describe, expect, it, vi } from "vitest"

import { createMachineDialer } from "./machine-dial.js"
import { OperationDeadline } from "./operation-deadline.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"
import * as endpoints from "./wsl-endpoint.js"
import * as distributions from "./wsl-list.js"

const id = `machine-${"b".repeat(32)}`
const credential = "p".repeat(43)
const published = { host: "127.0.0.1", port: 47900, token: "r".repeat(43) }
const wslEndpoint = "ws://127.0.0.1:47900/rpc"
const directEndpoint = "wss://studio.example/rpc"

afterEach(() => vi.restoreAllMocks())

function fixture(state: "Running" | "Stopped" = "Running") {
  const list = vi.spyOn(distributions, "listWslDistributions").mockResolvedValue([
    { name: "Ubuntu", version: 2, state, default: true },
  ])
  const read = vi.spyOn(endpoints, "readDistroEndpoint").mockResolvedValue(published)
  const open = vi.fn(async (_input: { endpoint: string; credential: string; deadline: OperationDeadline }) => ({
    call: async () => ({}), close: vi.fn(),
  }))
  const machine = { id, connection: "wsl" as const, wsl: { distribution: "Ubuntu", version: 2 as const },
    transports: [{ kind: "lan" as const, endpoint: directEndpoint, authenticated: true as const }] }
  const input = { machine: () => machine,
    credentials: asyncTestCredentials({ forMachine: () => credential, machines: () => [id], save: () => {}, forget: () => {} }),
    dialTimeoutMs: 2_000, open, wslPlatform: "win32" as const }
  return { input, list, read, open, machine }
}

describe("source-local WSL routes in the fleet dialer", () => {
  it("produces the WSL hop ahead of LAN only after the paired handshake", async () => {
    const f = fixture()
    const connection = await createMachineDialer(f.input)(id)
    expect(connection).toMatchObject({ routeSource: "wsl", endpoint: wslEndpoint,
      transport: { kind: "wsl", endpoint: wslEndpoint, authenticated: true } })
    expect(f.open).toHaveBeenCalledOnce()
    expect(f.open.mock.calls[0]?.[0]).toMatchObject({ endpoint: wslEndpoint, credential, expectedMachineId: id })
    expect(JSON.stringify(connection)).not.toContain(published.token)
    connection.close()
  })

  it("refuses a stopped distribution without reading it or dialing yesterday's loopback route", async () => {
    const f = fixture("Stopped")
    const dial = createMachineDialer({ ...f.input, machine: () => ({ ...f.machine, transports: [],
      verifiedRoute: { endpoint: wslEndpoint, lastAuthenticatedAt: new Date().toISOString() } }) })
    await expect(dial(id)).rejects.toMatchObject({ name: "WslTransportError", reason: "stopped" })
    expect(f.read).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
  })

  it("gives a silent WSL route only its share of the existing dial deadline", async () => {
    const f = fixture()
    f.open.mockImplementation(async (input) => input.endpoint === wslEndpoint
      ? new Promise(() => {}) : { call: async () => ({}), close: vi.fn() })
    const deadline = OperationDeadline.start(300)
    try {
      const connection = await createMachineDialer(f.input)(id, undefined, deadline)
      expect(connection).toMatchObject({ endpoint: directEndpoint, routeSource: "advertised" })
      expect(f.open.mock.calls.map(([input]) => input.endpoint)).toEqual([wslEndpoint, directEndpoint])
      expect(deadline.remainingMs()).toBeGreaterThan(0)
      connection.close()
    } finally { deadline.clear() }
  })

  it("keeps a final WSL timeout typed when the outer deadline wins the race", async () => {
    const f = fixture()
    f.open.mockImplementation(async () => new Promise(() => {}))
    await expect(createMachineDialer({ ...f.input, dialTimeoutMs: 30,
      machine: () => ({ ...f.machine, transports: [] }) })(id))
      .rejects.toMatchObject({ name: "WslTransportError", reason: "timed-out", distribution: "Ubuntu" })
  })

  it("cannot reach WSL without an eligible enrolled peer", async () => {
    const f = fixture()
    await expect(createMachineDialer({ ...f.input, machine: () => undefined })(id)).rejects.toThrow()
    expect(f.list).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
  })
})
