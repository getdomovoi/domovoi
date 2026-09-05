import { waitForDaemon } from "./test-wait-for.js"
import { once } from "node:events"

import { createEmptyWorkspace, demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"

import { claimMachineSocket, confirmMachineSocket, readMachineDescriptor } from "./machine-socket.js"
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
        claim: { state: "pending", deviceId: `device-${"c".repeat(32)}`, machineId: overrides.claimMachineId ?? sourceId, expiresAt: new Date(Date.now() + 300_000).toISOString() },
        token: credential, machine: { ...descriptor, id: targetId },
      } : call.method === "device.confirmClaim" ? { device: {
        id: `device-${"c".repeat(32)}`, label: "source", pairedAt: new Date().toISOString(),
        binding: { kind: "machine", machineId: overrides.claimMachineId ?? sourceId },
      } } : call.method === "system.hello" ? workspace
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
  it("closes the pending claim socket and authenticates only on a later confirmation socket", async () => {
    const machine = await target()
    const claimed = await claimMachineSocket(machine.input)
    expect(machine.calls.map((call) => call.method)).toEqual(["device.claim"])
    const connection = await confirmMachineSocket({ ...machine.input, claim: claimed.claim, expectedMachineId: targetId, credential: claimed.credential })
    try {
      expect(machine.connections()).toBe(2)
      expect(await readMachineDescriptor(connection, targetId, claimed.credential, machine.input.deadline)).toEqual(machine.descriptor)
      expect(machine.calls.map((call) => call.method)).toEqual(["device.claim", "device.confirmClaim", "system.hello", "fleet.heartbeat"])
      expect(machine.calls[0]?.params).toEqual({
        code: machine.input.code, label: "workshop", machineId: sourceId, protocolVersion,
      })
      expect(machine.calls[1]?.params).toEqual({ authToken: credential, machineId: sourceId, protocolVersion })
      expect(machine.calls[2]?.params).toEqual({ client: "machine", clientVersion: "0.0.1", protocolVersion, authToken: credential })
      expect(claimed.descriptor).toEqual(machine.descriptor)
      expect(claimed.credential).toBe(credential)
      expect(claimed.endpoint).toBe(machine.input.endpoint)
    } finally { connection.close() }
  })

  it("checks the expected identity and refuses self before publishing any facts", async () => {
    const machine = await target()
    await expect(claimMachineSocket({ ...machine.input, expectedMachineId: sourceId }))
      .rejects.toThrow("different machine")
    const self = await target({ claimMachineId: targetId })
    await expect(claimMachineSocket({ ...self.input, sourceMachineId: targetId }))
      .rejects.toThrow("cannot enroll itself")
    expect(self.calls.map((call) => call.method)).toEqual(["device.claim"])
  })

  it("checks the identity again in the authenticated descriptor", async () => {
    const machine = await target({ heartbeatId: sourceId })
    const claimed = await claimMachineSocket(machine.input)
    const connection = await confirmMachineSocket({ ...machine.input, claim: claimed.claim, expectedMachineId: targetId, credential: claimed.credential })
    try { await expect(readMachineDescriptor(connection, targetId, credential, machine.input.deadline)).rejects.toThrow("different machine") }
    finally { connection.close() }
  })

  it("retains a compatible descriptor patch version rather than requiring literal equality", async () => {
    const remoteVersion = `${protocolVersion.split(".").slice(0, 2).join(".")}.1`
    const machine = await target({ heartbeatVersion: remoteVersion })
    const claimed = await claimMachineSocket(machine.input)
    expect(claimed.descriptor.protocolVersion).toBe(remoteVersion)
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

  it.each(["device.claim", "device.confirmClaim", "system.hello", "fleet.heartbeat"])("bounds a silent %s with the original deadline", async (silenceAt) => {
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
    const outcome = (async () => {
      const claimed = await claimMachineSocket({ ...machine.input, deadline })
      const connection = await confirmMachineSocket({ ...machine.input, deadline, claim: claimed.claim, expectedMachineId: targetId, credential: claimed.credential })
      try { await readMachineDescriptor(connection, targetId, claimed.credential, deadline) }
      finally { connection.close() }
    })()
    const refused = expect(outcome).rejects.toThrow(/deadline|answer/)
    await waitForDaemon(() => expect(machine.calls.at(-1)?.method).toBe(silenceAt))
    expire!()
    await refused
    expect(machine.calls.at(-1)?.method).toBe(silenceAt)
  })
})
