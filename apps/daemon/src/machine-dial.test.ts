import { describe, expect, it } from "vitest"

import type { FleetMachine } from "@getdomovoi/protocol"

import { createMachineDialer } from "./machine-dial.js"

const credential = "n".repeat(43)
const machineId = `machine-${"b".repeat(32)}`

function machine(overrides: Partial<FleetMachine> = {}): FleetMachine {
  return {
    id: machineId,
    label: "studio",
    platform: "linux",
    arch: "x64",
    version: "0.0.1",
    connection: "tailnet",
    capabilities: ["sessions"],
    heartbeat: { state: "online", lastSeenAt: "2026-09-01T12:00:00.000Z" },
    protocolVersion: "0.1.0",
    transports: [
      { kind: "tailnet", endpoint: "wss://studio.tailnet:47831/rpc", authenticated: true },
    ],
    health: "healthy",
    self: false,
    ...overrides,
  }
}

function dialer(overrides: {
  machines?: FleetMachine[]
  forMachine?: (id: string) => string | undefined
  open?: (input: { endpoint: string; machineId: string; credential: string }) => Promise<{
    call: (method: string, params: Record<string, unknown>) => Promise<unknown>
    close: () => void
  }>
} = {}) {
  const opened: { endpoint: string; machineId: string; credential: string }[] = []
  const open = overrides.open
    ?? (async (input: { endpoint: string; machineId: string; credential: string }) => {
      opened.push(input)
      return { call: async () => ({}), close: () => {} }
    })
  return {
    opened,
    dial: createMachineDialer({
      machines: () => overrides.machines ?? [machine()],
      credentials: {
        save: () => {},
        forMachine: overrides.forMachine ?? (() => credential),
        forget: () => {},
        machines: () => [machineId],
      },
      open,
    }),
  }
}

describe("createMachineDialer", () => {
  it("dials a machine with the credential kept for it", async () => {
    const io = dialer()

    const connection = await io.dial(machineId)

    expect(io.opened).toEqual([{
      endpoint: "wss://studio.tailnet:47831/rpc",
      machineId,
      credential,
    }])
    connection.close()
  })

  it("prefers the transport the fleet ranks first", async () => {
    const io = dialer({
      machines: [machine({
        transports: [
          { kind: "relay", endpoint: "wss://relay.example:443/rpc", authenticated: true },
          { kind: "lan", endpoint: "wss://studio.lan:47831/rpc", authenticated: true },
        ],
      })],
    })

    await io.dial(machineId)

    expect(io.opened[0]!.endpoint).toBe("wss://studio.lan:47831/rpc")
  })

  it("refuses a machine it keeps no credential for", async () => {
    const io = dialer({ forMachine: () => undefined })

    await expect(io.dial(machineId)).rejects.toThrow("That machine has to be paired again")
    expect(io.opened).toEqual([])
  })

  it("refuses a machine the fleet does not describe", async () => {
    const io = dialer({ machines: [] })

    await expect(io.dial(machineId)).rejects.toThrow("That machine cannot be reached")
    expect(io.opened).toEqual([])
  })

  it("never sends a credential to an unencrypted remote endpoint", async () => {
    const io = dialer({
      machines: [machine({
        transports: [
          { kind: "lan", endpoint: "ws://studio.lan:47831/rpc", authenticated: true },
        ],
      })],
    })

    await expect(io.dial(machineId))
      .rejects.toThrow("Refusing to authenticate over an unencrypted connection")
    expect(io.opened).toEqual([])
  })

  it("refuses a remote machine that claims a loopback address", async () => {
    // Nothing ties an advertised endpoint to the transport it claims, so a
    // machine elsewhere can name a loopback address and be handed a credential
    // meant for it by whatever is listening here.
    const io = dialer({
      machines: [machine({
        connection: "tailnet",
        transports: [
          { kind: "tailnet", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true },
        ],
      })],
    })

    await expect(io.dial(machineId))
      .rejects.toThrow("Refusing to authenticate over an unencrypted connection")
    expect(io.opened).toEqual([])
  })

  it("dials loopback without encryption, where nothing leaves the machine", async () => {
    const io = dialer({
      machines: [machine({
        connection: "local",
        transports: [
          { kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true },
        ],
      })],
    })

    await io.dial(machineId)

    expect(io.opened[0]!.endpoint).toBe("ws://127.0.0.1:47831/rpc")
  })
})
