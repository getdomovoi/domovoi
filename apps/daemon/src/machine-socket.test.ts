import { waitForDaemon } from "./test-wait-for.js"
import { once } from "node:events"

import { WebSocketServer } from "ws"
import { afterEach, describe, expect, it } from "vitest"

import {
  daemonAuthenticationErrorCode,
  createEmptyWorkspace,
  demoWorkspace,
  protocolCompatibility,
  protocolVersion,
  protocolVersionMismatchErrorCode,
} from "@getdomovoi/protocol"

import type { MachineConnection } from "./machine-dial.js"
import {
  defaultMachineCallTimeoutMs,
  defaultMachineHandshakeTimeoutMs,
  MachinePairingRequiredError,
  MachineProtocolMismatchError,
  openMachineSocket as openMachineSocketWithoutDefaults,
  protocolMismatchRefusal,
  readMachineDescriptor,
} from "./machine-socket.js"
import { OperationDeadline } from "./operation-deadline.js"

const servers: WebSocketServer[] = []
const machineId = `machine-${"a".repeat(32)}`
const machineWorkspace = createEmptyWorkspace({ ...demoWorkspace.machine, id: machineId })

function openMachineSocket(
  input: Omit<Parameters<typeof openMachineSocketWithoutDefaults>[0], "expectedMachineId" | "deadline" | "callTimeoutMs"> & {
    expectedMachineId?: string
    callTimeoutMs?: number
    scheduler?: NonNullable<Parameters<typeof OperationDeadline.start>[1]>["scheduler"]
  },
) {
  const { scheduler, ...socketInput } = input
  const deadline = OperationDeadline.start(defaultMachineHandshakeTimeoutMs, scheduler ? { scheduler } : {})
  return openMachineSocketWithoutDefaults({
    ...socketInput,
    deadline,
    callTimeoutMs: input.callTimeoutMs ?? defaultMachineCallTimeoutMs,
    expectedMachineId: input.expectedMachineId ?? machineId,
  }).finally(() => deadline.clear())
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

async function machineServer(handler: (message: Record<string, unknown>) => unknown) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  servers.push(server)
  await once(server, "listening")
  const seen: Record<string, unknown>[] = []
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      seen.push(message)
      const result = handler(message)
      if (result === undefined) return
      const reply = result && typeof result === "object" && "rpcError" in result ? { error: result.rpcError } : { result }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }))
    })
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return { seen, endpoint: `ws://127.0.0.1:${port}/rpc` }
}

describe("openMachineSocket", () => {
  it("refuses an endpoint answered by a different machine", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return structuredClone(machineWorkspace)
      return { state: "unknown" }
    })

    const opening = openMachineSocket({
      endpoint: machine.endpoint,
      expectedMachineId: `machine-${"f".repeat(32)}`,
      credential: "n".repeat(43),
    })
    void opening.then((connection) => connection.close(), () => {})
    await expect(opening).rejects.toThrow("The endpoint answered as a different machine")
    expect(machine.seen).toHaveLength(1)
  })

  it("says hello with the credential before anything else", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return structuredClone(machineWorkspace)
      return { state: "receiving" }
    })

    const connection = await openMachineSocket({
      endpoint: machine.endpoint,
      credential: "n".repeat(43),
    })
    await connection.call("transfer.begin", { sessionId: "session-1" })
    connection.close()

    expect(machine.seen[0]).toMatchObject({
      method: "system.hello",
      params: {
        client: "machine",
        clientVersion: "0.0.1",
        protocolVersion,
        authToken: "n".repeat(43),
      },
    })
    expect((machine.seen[0]!.params as Record<string, unknown>)).not.toHaveProperty("machineId")
    expect(machine.seen[1]).toMatchObject({ method: "transfer.begin" })
  })

  it("refuses a machine that speaks another protocol version", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") {
        return { ...structuredClone(machineWorkspace), protocolVersion: "9.9.9" }
      }
      return { state: "receiving" }
    })

    await expect(openMachineSocket({
      endpoint: machine.endpoint,
      credential: "n".repeat(43),
    })).rejects.toThrow(`That machine speaks protocol 9.9.9, this daemon speaks ${protocolVersion}`)
  })

  const mismatchData = (daemonProtocolVersion: string) => ({
    kind: "protocol-mismatch", daemonProtocolVersion, clientProtocolVersion: protocolVersion,
    compatibility: protocolCompatibility(daemonProtocolVersion, protocolVersion),
  })
  const claimRefusal = "Update both daemons to the same protocol before pairing"
  const sentenceRefusal = protocolMismatchRefusal("0.3.0", protocolVersion)
  const named = (version: string) => `That machine speaks protocol ${version}, this daemon speaks ${protocolVersion}`

  it.each([
    ["carries the daemon's version as data", { message: claimRefusal, data: mismatchData("0.2.0") }, "0.2.0", named("0.2.0")],
    ["carries data that disagrees with its sentence", { message: sentenceRefusal, data: mismatchData("0.2.0") }, "0.2.0", named("0.2.0")],
    ["carries data this daemon cannot read", { message: sentenceRefusal, data: { kind: "protocol-mismatch" } }, "0.3.0", named("0.3.0")],
    ["names the daemon's version in its sentence only", { message: sentenceRefusal }, "0.3.0", named("0.3.0")],
    ["names no version", { message: claimRefusal }, undefined, "That machine speaks an incompatible protocol"],
  ])("keeps the version when a protocol refusal %s", async (_case, refusal, remoteVersion, message) => {
    const machine = await machineServer(() => ({ rpcError: { code: protocolVersionMismatchErrorCode, ...refusal } }))
    const refused: unknown = await openMachineSocket({ endpoint: machine.endpoint, credential: "n".repeat(43) })
      .then(() => undefined, (cause: unknown) => cause)
    expect(refused).toBeInstanceOf(MachineProtocolMismatchError)
    expect(refused).toMatchObject({ remoteVersion, message })
  })

  it("accepts a compatible patch version without skipping workspace or identity validation", async () => {
    const remoteVersion = `${protocolVersion.split(".").slice(0, 2).join(".")}.1`
    const machine = await machineServer(() => ({ ...structuredClone(machineWorkspace), protocolVersion: remoteVersion }))
    const connection = await openMachineSocket({ endpoint: machine.endpoint, credential: "n".repeat(43) })
    connection.close()
    expect(machine.seen).toHaveLength(1)

    const invalid = await machineServer(() => ({ ...structuredClone(machineWorkspace), sessions: "invalid", protocolVersion: remoteVersion }))
    await expect(openMachineSocket({ endpoint: invalid.endpoint, credential: "n".repeat(43) }))
      .rejects.toThrow("invalid descriptor")
    await expect(openMachineSocket({ endpoint: machine.endpoint, credential: "n".repeat(43), expectedMachineId: `machine-${"f".repeat(32)}` }))
      .rejects.toThrow("different machine")
  })

  it("classifies a rejected machine credential without exposing its history", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    servers.push(server)
    await once(server, "listening")
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number }
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: daemonAuthenticationErrorCode,
            message: "Daemon authentication failed",
          },
        }))
      })
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    const opening = openMachineSocket({
      endpoint: `ws://127.0.0.1:${port}/rpc`,
      credential: "n".repeat(43),
    })
    await expect(opening).rejects.toBeInstanceOf(MachinePairingRequiredError)
    await expect(opening).rejects.toThrow("That machine must be paired again")
  })

  it("answers each call with the reply that carries its id", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return structuredClone(machineWorkspace)
      return { echoed: message.id }
    })

    const connection = await openMachineSocket({
      endpoint: machine.endpoint,
      credential: "n".repeat(43),
    })
    const [first, second] = await Promise.all([
      connection.call("transfer.chunk", { sequence: 0 }),
      connection.call("transfer.chunk", { sequence: 1 }),
    ])
    connection.close()

    expect(first).not.toEqual(second)
  })

  it("fails a call the machine refuses, in the machine's words", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    servers.push(server)
    await once(server, "listening")
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; method?: string }
        if (message.method === "system.hello") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: structuredClone(machineWorkspace) }))
          return
        }
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "That transfer is not arriving" },
        }))
      })
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    const connection = await openMachineSocket({
      endpoint: `ws://127.0.0.1:${port}/rpc`,
      credential: "n".repeat(43),
    })

    await expect(connection.call("transfer.chunk", {}))
      .rejects.toThrow("That transfer is not arriving")
    connection.close()
  })

  it("fails every pending call when the machine hangs up", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    servers.push(server)
    await once(server, "listening")
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; method?: string }
        if (message.method === "system.hello") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: structuredClone(machineWorkspace) }))
          return
        }
        socket.close()
      })
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    const connection = await openMachineSocket({
      endpoint: `ws://127.0.0.1:${port}/rpc`,
      credential: "n".repeat(43),
    })

    await expect(connection.call("transfer.chunk", {}))
      .rejects.toThrow("The machine closed the connection")
  })

  it("refuses a plaintext endpoint that leaves this machine", async () => {
    await expect(openMachineSocket({
      endpoint: "ws://studio.tailnet:47831/rpc",
      credential: "n".repeat(43),
    })).rejects.toThrow("Refusing to authenticate over an unencrypted connection")
  })

  it("refuses a call once the connection is closed", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return structuredClone(machineWorkspace)
      return { state: "receiving" }
    })

    const connection = await openMachineSocket({
      endpoint: machine.endpoint,
      credential: "n".repeat(43),
    })
    connection.close()

    await expect(connection.call("transfer.chunk", {}))
      .rejects.toThrow("The machine connection is closed")
  })

  it("gives up on a call the machine never answers", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return structuredClone(machineWorkspace)
      return undefined
    })

    const connection = await openMachineSocket({
      endpoint: machine.endpoint,
      credential: "n".repeat(43),
      callTimeoutMs: 100,
    })

    await expect(connection.call("transfer.chunk", {}))
      .rejects.toThrow("That machine stopped answering")
    connection.close()
  })

  it("refuses more calls than it will keep waiting for", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return structuredClone(machineWorkspace)
      return undefined
    })

    const connection = await openMachineSocket({
      endpoint: machine.endpoint,
      credential: "n".repeat(43),
      callTimeoutMs: 5_000,
      maximumPendingCalls: 2,
    })
    const pending = [
      connection.call("transfer.chunk", { sequence: 0 }).catch(() => "settled"),
      connection.call("transfer.chunk", { sequence: 1 }).catch(() => "settled"),
    ]

    await expect(connection.call("transfer.chunk", { sequence: 2 }))
      .rejects.toThrow("Too many calls are waiting on that machine")
    connection.close()
    await Promise.all(pending)
  })

  it("refuses a late result even when the deadline timer has not run", async () => {
    let now = 0
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return structuredClone(machineWorkspace)
      now = 101
      return { state: "committed" }
    })
    const connection = await openMachineSocket({ endpoint: machine.endpoint, credential: "n".repeat(43) })
    const deadline = OperationDeadline.start(100, {
      now: () => now,
      scheduler: { setTimeout: () => 1, clearTimeout: () => {} },
    })
    try {
      await expect(connection.call("transfer.status", {}, undefined, deadline))
        .rejects.toThrow("That machine stopped answering before the deadline")
    } finally { connection.close(); deadline.clear() }
  })

  it("stops waiting when the transfer is cancelled", async () => {
    const machine = await machineServer((message) => {
      if (message.method === "system.hello") return structuredClone(machineWorkspace)
      return undefined
    })
    const cancelled = new AbortController()

    const connection = await openMachineSocket({
      endpoint: machine.endpoint,
      credential: "n".repeat(43),
    })
    const call = connection.call("transfer.chunk", {}, cancelled.signal)
    cancelled.abort()

    await expect(call).rejects.toThrow("The transfer was cancelled")
    connection.close()
  })

  it("gives up on a handshake the caller cancels", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    servers.push(server)
    await once(server, "listening")
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const cancelled = new AbortController()

    const opening = openMachineSocket({
      endpoint: `ws://127.0.0.1:${port}/rpc`,
      credential: "n".repeat(43),
      signal: cancelled.signal,
    })
    cancelled.abort()

    await expect(opening).rejects.toThrow("The transfer was cancelled")
  })

  it("gives up on a machine that never answers the handshake", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    servers.push(server)
    await once(server, "listening")
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    // The deadline is driven rather than waited on, so the test does not
    // depend on how busy the machine running it is.
    const fired: (() => void)[] = []
    const opening = openMachineSocket({
      endpoint: `ws://127.0.0.1:${port}/rpc`,
      credential: "n".repeat(43),
      scheduler: {
        setTimeout: (callback: () => void) => {
          fired.push(callback)
          return fired.length
        },
        clearTimeout: () => {},
      },
    })
    await waitForDaemon(() => expect(fired.length).toBeGreaterThan(0))
    for (const callback of fired) callback()

    await expect(opening).rejects.toThrow("That machine did not answer")
  })
})

describe("readMachineDescriptor", () => {
  const descriptor = {
    id: machineId,
    label: "workshop",
    platform: "linux",
    arch: "x64",
    version: "0.0.1",
    capabilities: ["sessions"],
    protocolVersion,
    transports: [{ kind: "local", endpoint: "ws://127.0.0.1:47831/rpc", authenticated: true }],
  }
  const wsl = { distribution: "Ubuntu-24.04", version: 2 }

  function heartbeat(result: unknown) {
    const connection: MachineConnection = { call: async () => result, close: () => {} }
    const deadline = OperationDeadline.start(1_000)
    return readMachineDescriptor(connection, machineId, "n".repeat(43), deadline).finally(() => deadline.clear())
  }

  it("keeps the WSL facts a linux daemon reports from inside a distribution", async () => {
    await expect(heartbeat({ ...descriptor, wsl })).resolves.toMatchObject({ platform: "linux", wsl })
  })

  it("refuses a heartbeat that pairs WSL facts with a platform no distribution runs", async () => {
    await expect(heartbeat({ ...descriptor, platform: "win32", wsl })).rejects.toThrow("invalid descriptor")
  })
})
