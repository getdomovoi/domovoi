import { asyncTestCredentials } from "./test-machine-credentials.js"
import { describe, expect, it, vi } from "vitest"

import type { FleetMachine } from "@getdomovoi/protocol"

import { createMachineDialer } from "./machine-dial.js"
import { OperationDeadline } from "./operation-deadline.js"
import { MachineIdentityMismatchError } from "./machine-socket.js"
import { waitForDaemon } from "./test-wait-for.js"

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
  open?: (input: { endpoint: string; expectedMachineId: string; credential: string }) => Promise<{
    call: (method: string, params: Record<string, unknown>) => Promise<unknown>
    close: () => void
  }>
} = {}) {
  const opened: Array<{
    endpoint: string
    expectedMachineId: string
    credential: string
  }> = []
  const open = overrides.open
    ?? (async (input: {
      endpoint: string
      expectedMachineId: string
      credential: string
    }) => {
      opened.push(input)
      return { call: async () => ({}), close: () => {} }
    })
  return {
    opened,
    dial: createMachineDialer({
      machine: (id) => (overrides.machines ?? [machine()]).find((candidate) => candidate.id === id),
      credentials: asyncTestCredentials({
        save: () => {},
        forMachine: overrides.forMachine ?? (() => credential),
        forget: () => {},
        machines: () => [machineId],
      }),
      open,
      dialTimeoutMs: 1_000,
    }),
  }
}

describe("createMachineDialer", () => {
  it.each(["ineligible", "missing-credential", "different-machine"] as const)("cannot enable an SSH route past %s", async (scenario) => {
    const open = vi.fn(async () => ({ call: async () => ({}), close: () => {} }))
    const dial = createMachineDialer({
      machine: () => scenario === "ineligible" ? undefined : machine({ transports: [] }),
      credentials: asyncTestCredentials({ save: () => {}, forget: () => {}, machines: () => [machineId],
        forMachine: () => scenario === "missing-credential" ? undefined : credential }),
      sshTunnels: [{ machineId: scenario === "different-machine" ? `machine-${"c".repeat(32)}` : machineId,
        endpoint: "ws://127.0.0.1:47900/rpc" }],
      dialTimeoutMs: 1000, open,
    })
    await expect(dial(machineId)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })

  it("does not try SSH after a direct route fails verified identity", async () => {
    const open = vi.fn(async () => { throw new MachineIdentityMismatchError() })
    const dial = createMachineDialer({
      machine: () => machine(),
      credentials: asyncTestCredentials({ save: () => {}, forget: () => {}, machines: () => [machineId], forMachine: () => credential }),
      sshTunnels: [{ machineId, endpoint: "ws://127.0.0.1:47900/rpc" }],
      dialTimeoutMs: 1000, open,
    })
    await expect(dial(machineId)).rejects.toBeInstanceOf(MachineIdentityMismatchError)
    expect(open).toHaveBeenCalledOnce()
  })

  it("never opens a socket for invalid source-local configuration", () => {
    const open = vi.fn(async () => ({ call: async () => ({}), close: () => {} }))
    expect(() => createMachineDialer({ machine: () => machine(), credentials: undefined, dialTimeoutMs: 1000, open,
      sshTunnels: [{ machineId, endpoint: "ws://127.0.0.1.example.com/rpc" }],
    })).toThrow()
    expect(open).not.toHaveBeenCalled()
  })

  it("produces a configured local SSH fallback within the original route deadline", async () => {
    let now = 0
    const deadline = OperationDeadline.start(100, { now: () => now })
    const seen: Array<{ endpoint: string; remaining: number; deadline: OperationDeadline }> = []
    const input = {
      machine: () => machine(),
      credentials: asyncTestCredentials({ save: () => {}, forget: () => {}, machines: () => [machineId], forMachine: () => credential }),
      sshTunnels: [{ machineId, endpoint: "ws://127.0.0.1:47900/rpc" }],
      dialTimeoutMs: 1000,
      open: async (options: { endpoint: string; expectedMachineId: string; credential: string; deadline: OperationDeadline }) => {
        expect(options.expectedMachineId).toBe(machineId)
        expect(options.credential).toBe(credential)
        seen.push({ endpoint: options.endpoint, remaining: options.deadline.remainingMs(), deadline: options.deadline })
        if (seen.length === 1) { now = 75; throw new Error("direct route is down") }
        return { call: async () => ({}), close: () => {} }
      },
    }
    try {
      expect(await createMachineDialer(input)(machineId, undefined, deadline)).toMatchObject({
        endpoint: "ws://127.0.0.1:47900/rpc", routeSource: "ssh",
      })
      expect(seen.map(({ endpoint, remaining }) => ({ endpoint, remaining }))).toEqual([
        { endpoint: "wss://studio.tailnet:47831/rpc", remaining: 50 },
        { endpoint: "ws://127.0.0.1:47900/rpc", remaining: 25 },
      ])
      expect(seen[0]?.deadline).not.toBe(seen[1]?.deadline)
    } finally { deadline.clear() }
  })

  it("never accepts the target's assertion that an SSH forward is configured here", async () => {
    const io = dialer({ machines: [machine({ transports: [
      { kind: "ssh", endpoint: "wss://localhost:47900/rpc", authenticated: true, configured: true },
    ] })] })
    await expect(io.dial(machineId)).rejects.toThrow("no usable transport")
    expect(io.opened).toEqual([])
  })

  it("does not mistake a peer's TLS loopback advertisement for a configured source route", async () => {
    const forward = "wss://localhost:47900/rpc"
    const input = {
      machine: () => machine({ connection: "direct", transports: [
        { kind: "local" as const, endpoint: forward, authenticated: true as const },
      ] }),
      credentials: asyncTestCredentials({ save: () => {}, forget: () => {}, machines: () => [machineId], forMachine: () => credential }),
      dialTimeoutMs: 1000,
      open: vi.fn(async () => ({ call: async () => ({}), close: () => {} })),
    }
    await expect(createMachineDialer(input)(machineId)).rejects.toThrow()
    expect(input.open).not.toHaveBeenCalled()
    expect(await createMachineDialer({ ...input, sshTunnels: [{ machineId, endpoint: forward }] })(machineId))
      .toMatchObject({ endpoint: forward, routeSource: "ssh" })
  })

  it("rechecks eligibility after the credential await so a forgetting peer cannot dial", async () => {
    const deadline = OperationDeadline.start(1_000)
    const credentials = asyncTestCredentials({ save: () => {}, forget: () => {}, machines: () => [machineId], forMachine: () => credential })
    let release: (value: string) => void = () => {}
    const read = vi.spyOn(credentials, "forMachine").mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    let eligible = true
    const open = vi.fn(async () => ({ call: async () => ({}), close: () => {} }))
    const dial = createMachineDialer({ machine: () => eligible ? machine() : undefined, credentials, dialTimeoutMs: 1_000, open })
    try {
      const pending = dial(machineId, undefined, deadline)
      const refused = expect(pending).rejects.toThrow("cannot be reached")
      expect(read).toHaveBeenCalledOnce()
      eligible = false
      release(credential)
      await refused
      expect(open).not.toHaveBeenCalled()
    } finally { deadline.clear() }
  })

  it("never opens after an expired credential read settles late", async () => {
    let now = 0
    const deadline = OperationDeadline.start(1_000, { now: () => now })
    const credentials = asyncTestCredentials({ save: () => {}, forget: () => {}, machines: () => [machineId], forMachine: () => credential })
    let release: (value: string) => void = () => {}
    vi.spyOn(credentials, "forMachine").mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const open = vi.fn(async () => ({ call: async () => ({}), close: () => {} }))
    const dial = createMachineDialer({ machine: () => machine(), credentials, dialTimeoutMs: 1_000, open })
    try {
      const refused = expect(dial(machineId, undefined, deadline)).rejects.toThrow(/deadline/)
      now = 1_001
      release(credential)
      await refused
      expect(open).not.toHaveBeenCalled()
    } finally { deadline.clear() }
  })

  it("dials a machine with the credential kept for it", async () => {
    const io = dialer()

    const connection = await io.dial(machineId)

    expect(io.opened).toEqual([{
      endpoint: "wss://studio.tailnet:47831/rpc",
      expectedMachineId: machineId,
      credential,
      deadline: expect.any(OperationDeadline),
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

  it("prefers a source-verified endpoint even when the target never advertised it", async () => {
    const io = dialer({ machines: [machine({
      connection: "direct",
      verifiedRoute: { endpoint: "wss://studio-forward.example:443/rpc", lastAuthenticatedAt: new Date(0).toISOString() },
    })] })
    await io.dial(machineId)
    expect(io.opened[0]?.endpoint).toBe("wss://studio-forward.example:443/rpc")
  })

  it("tries fallback routes within one shared deadline without redialing the same endpoint", async () => {
    let now = 0
    const deadline = OperationDeadline.start(100, { now: () => now })
    const seen: Array<{ endpoint: string; remaining: number; deadline: OperationDeadline }> = []
    const connection = { call: async () => ({}), close: () => {} }
    const dial = createMachineDialer({
      machine: () => machine({ verifiedRoute: { endpoint: "wss://studio.old/rpc", lastAuthenticatedAt: new Date(0).toISOString() },
        transports: [
          { kind: "tailnet", endpoint: "wss://studio.tailnet/rpc", authenticated: true },
          { kind: "lan", endpoint: "wss://studio.old/rpc", authenticated: true },
        ],
      }),
      credentials: asyncTestCredentials({ save: () => {}, forget: () => {}, machines: () => [machineId], forMachine: () => credential }),
      dialTimeoutMs: 1_000,
      open: async (input) => {
        seen.push({ endpoint: input.endpoint, remaining: input.deadline.remainingMs(), deadline: input.deadline })
        if (seen.length === 1) { now = 75; throw new Error("old endpoint went away") }
        return connection
      },
    })
    try {
      const result = await dial(machineId, undefined, deadline)
      expect(seen.map(({ endpoint, remaining }) => ({ endpoint, remaining }))).toEqual([
        { endpoint: "wss://studio.old/rpc", remaining: 50 },
        { endpoint: "wss://studio.tailnet/rpc", remaining: 25 },
      ])
      expect(seen[0]?.deadline).not.toBe(seen[1]?.deadline)
      expect(result.endpoint).toBe("wss://studio.tailnet/rpc")
    } finally { deadline.clear() }
  })

  it("does not start another route once the original budget is spent", async () => {
    let now = 0
    const deadline = OperationDeadline.start(100, { now: () => now })
    const open = vi.fn(async () => { now = 101; throw new Error("gone") })
    const dial = createMachineDialer({
      machine: () => machine({ transports: [
        { kind: "lan", endpoint: "wss://studio.lan/rpc", authenticated: true },
        { kind: "tailnet", endpoint: "wss://studio.tailnet/rpc", authenticated: true },
      ] }),
      credentials: asyncTestCredentials({ save: () => {}, forget: () => {}, machines: () => [machineId], forMachine: () => credential }),
      dialTimeoutMs: 1_000, open,
      sshTunnels: [{ machineId, endpoint: "ws://127.0.0.1:47900/rpc" }],
    })
    try {
      await expect(dial(machineId, undefined, deadline)).rejects.toThrow(/deadline/)
      expect(open).toHaveBeenCalledOnce()
    } finally { deadline.clear() }
  })

  it("bounds an opener that ignores cancellation and closes a late connection", async () => {
    let now = 0
    const deadline = OperationDeadline.start(100, { now: () => now })
    const close = vi.fn()
    let complete: (connection: { call: () => Promise<unknown>; close: () => void }) => void = () => {}
    const open = vi.fn(() => new Promise<{ call: () => Promise<unknown>; close: () => void }>((resolve) => { complete = resolve }))
    const dial = createMachineDialer({
      machine: () => machine(),
      credentials: asyncTestCredentials({ save: () => {}, forget: () => {}, machines: () => [machineId], forMachine: () => credential }),
      dialTimeoutMs: 1_000,
      open,
    })
    const opening = dial(machineId, undefined, deadline)
    const refused = expect(opening).rejects.toMatchObject({
      name: "MachineDialTimeoutError", stage: "connect-and-hello", target: "wss://studio.tailnet:47831",
      message: expect.stringContaining("connect and authenticated hello"),
    })
    // Credential access is async too. Expire the opener after it actually
    // starts, not while the credential phase is still pending.
    await waitForDaemon(() => expect(open).toHaveBeenCalledOnce())
    now = 101
    deadline.remainingMs()
    await refused
    complete({ call: async () => ({}), close })
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    deadline.clear()
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
