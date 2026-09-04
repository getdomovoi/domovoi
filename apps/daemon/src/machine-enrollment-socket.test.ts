import { once } from "node:events"

import { createEmptyWorkspace, demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer } from "ws"

import { claimMachineSocket } from "./machine-socket.js"
import { OperationDeadline } from "./operation-deadline.js"

const sourceId = `machine-${"a".repeat(32)}`
const targetId = `machine-${"b".repeat(32)}`
const credential = "n".repeat(43)
const servers: WebSocketServer[] = []
const deadlines: OperationDeadline[] = []
afterEach(async () => {
  for (const deadline of deadlines.splice(0)) deadline.clear()
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function target(overrides: { heartbeatId?: string; label?: string; silenceAt?: string; claimMachineId?: string; heartbeatVersion?: string } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  servers.push(server)
  await once(server, "listening")
  let connections = 0
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const workspace = createEmptyWorkspace({ ...demoWorkspace.machine, id: targetId })
  const descriptor = {
    id: overrides.heartbeatId ?? targetId, label: overrides.label ?? "studio", platform: "darwin", arch: "arm64",
    version: "0.0.1", protocolVersion: overrides.heartbeatVersion ?? protocolVersion, capabilities: ["sessions"], transports: [],
  }
  server.on("connection", (socket) => {
    connections += 1
    socket.on("message", (data) => {
      const call = JSON.parse(data.toString()) as { id: number; method: string; params: Record<string, unknown> }
      calls.push(call)
      if (call.method === overrides.silenceAt) return
      const result = call.method === "device.claim" ? {
        device: {
          id: `device-${"c".repeat(32)}`, label: "source", pairedAt: new Date(0).toISOString(),
          binding: { kind: "machine", machineId: overrides.claimMachineId ?? sourceId },
        }, token: credential,
      } : call.method === "system.hello" ? workspace
        : call.method === "fleet.heartbeat" ? descriptor : { revoked: true }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }))
    })
  })
  const address = server.address() as { port: number }
  const deadline = OperationDeadline.start(1_000)
  deadlines.push(deadline)
  return {
    calls, connections: () => connections, descriptor,
    input: { endpoint: `ws://127.0.0.1:${address.port}/rpc`, sourceMachineId: sourceId,
      code: "hearth-quiet-ember-42", sourceDeviceLabel: "workshop", deadline, callTimeoutMs: 1_000 },
  }
}

describe("machine enrollment socket", () => {
  it("claims, authenticates and fetches target facts on one real socket", async () => {
    const machine = await target()
    const claimed = await claimMachineSocket(machine.input)
    try {
      expect(machine.connections()).toBe(1)
      expect(machine.calls.map((call) => call.method)).toEqual(["device.claim", "system.hello", "fleet.heartbeat"])
      expect(machine.calls[0]?.params).toEqual({
        code: machine.input.code, label: "workshop", machineId: sourceId, protocolVersion,
      })
      expect(machine.calls[1]?.params).toEqual({ client: "machine", clientVersion: "0.0.1", protocolVersion, authToken: credential })
      expect(claimed.descriptor).toEqual(machine.descriptor)
      expect(claimed.credential).toBe(credential)
      expect(claimed.endpoint).toBe(machine.input.endpoint)
    } finally { claimed.connection.close() }
  })

  it("checks the expected identity and refuses self before publishing any facts", async () => {
    const machine = await target()
    await expect(claimMachineSocket({ ...machine.input, expectedMachineId: sourceId }))
      .rejects.toThrow("different machine")
    const self = await target({ claimMachineId: targetId })
    await expect(claimMachineSocket({ ...self.input, sourceMachineId: targetId }))
      .rejects.toThrow("cannot enroll itself")
    expect(self.calls.map((call) => call.method)).toEqual(["device.claim", "system.hello"])
  })

  it("checks the identity again in the authenticated descriptor", async () => {
    const machine = await target({ heartbeatId: sourceId })
    await expect(claimMachineSocket(machine.input)).rejects.toThrow("different machine")
  })

  it("retains a compatible descriptor patch version rather than requiring literal equality", async () => {
    const remoteVersion = `${protocolVersion.split(".").slice(0, 2).join(".")}.1`
    const machine = await target({ heartbeatVersion: remoteVersion })
    const claimed = await claimMachineSocket(machine.input)
    try { expect(claimed.descriptor.protocolVersion).toBe(remoteVersion) }
    finally { claimed.connection.close() }
  })

  it("refuses a claim bound to another machine before sending its credential", async () => {
    const machine = await target({ claimMachineId: targetId })
    await expect(claimMachineSocket(machine.input)).rejects.toThrow("credential binding")
    expect(machine.calls.map((call) => call.method)).toEqual(["device.claim"])
  })

  it("refuses target facts that echo the newly issued secret, without reflecting it in the error", async () => {
    const machine = await target({ label: credential })
    const outcome = claimMachineSocket(machine.input)
    await expect(outcome).rejects.toThrow("descriptor")
    await expect(outcome).rejects.not.toThrow(credential)
  })

  it.each(["device.claim", "system.hello", "fleet.heartbeat"])("bounds a silent %s with the original deadline", async (silenceAt) => {
    const machine = await target({ silenceAt })
    let expire: (() => void) | undefined
    const deadline = OperationDeadline.start(1_000, {
      now: () => 0,
      scheduler: {
        setTimeout: (callback) => { expire ??= callback; return 1 },
        clearTimeout: () => {},
      },
    })
    deadlines.push(deadline)
    const outcome = claimMachineSocket({ ...machine.input, deadline })
    const refused = expect(outcome).rejects.toThrow(/deadline|answer/)
    await vi.waitFor(() => expect(machine.calls.at(-1)?.method).toBe(silenceAt))
    expire!()
    await refused
    expect(machine.calls.at(-1)?.method).toBe(silenceAt)
  })
})
