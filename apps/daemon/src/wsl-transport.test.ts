import { createServer, type Socket } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createMachineDialer } from "./machine-dial.js"
import { MachinePairingRequiredError, openMachineSocket, readMachineDescriptor } from "./machine-socket.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { fleetProductionHarness } from "./test-fleet-production.js"
import { asyncTestCredentials } from "./test-machine-credentials.js"
import * as endpoints from "./wsl-endpoint.js"
import * as distributions from "./wsl-list.js"
import { openWslTransport } from "./wsl-transport.js"

const { cleanup, machine, enroll } = fleetProductionHarness()
afterEach(async () => { vi.restoreAllMocks(); await cleanup() })

async function fixture() {
  const source = await machine("Windows source")
  const target = await machine("Ubuntu guest")
  await enroll(source, target)
  vi.spyOn(distributions, "listWslDistributions").mockResolvedValue([
    { name: "Ubuntu", version: 2, state: "Running", default: true },
  ])
  const read = vi.spyOn(endpoints, "readDistroEndpoint").mockResolvedValue({
    host: target.address.host, port: target.address.port, token: target.handle.authToken,
  })
  const credential = source.credentials.forMachine(target.id)!
  return { source, target, credential, read }
}

describe("WSL route admission over real daemon sockets", () => {
  it("returns a candidate only after machine authentication and never upgrades it to root authority", async () => {
    const f = await fixture()
    const deadline = OperationDeadline.start(5_000)
    try {
      const route = await openWslTransport({ distribution: "Ubuntu", expectedMachineId: f.target.id,
        credential: f.credential, deadline, open: (input) => openMachineSocket({ ...input, callTimeoutMs: 1_000 }) })
      try {
        expect(route.transport).toEqual({ kind: "wsl", endpoint: f.target.address.url, authenticated: true })
        expect(await readMachineDescriptor(route, f.target.id, f.credential, deadline)).toMatchObject({ id: f.target.id })
        await expect(route.call("workspace.get", {}, undefined, deadline)).rejects.toThrow()
      } finally { route.close() }
    } finally { deadline.clear() }
  })

  it.each(["wrong", "root", "revoked"] as const)("refuses %s credentials without producing a route", async (scenario) => {
    const f = await fixture()
    if (scenario === "revoked") {
      const devices = await f.target.root.ok("device.list", {}) as { devices: Array<{ id: string }> }
      await f.target.root.ok("device.revoke", { deviceId: devices.devices[0]!.id, client: "cli" })
    }
    const deadline = OperationDeadline.start(5_000)
    try {
      await expect(openWslTransport({ distribution: "Ubuntu", expectedMachineId: f.target.id,
        credential: scenario === "wrong" ? "x".repeat(43) : scenario === "root" ? f.target.handle.authToken : f.credential,
        deadline, open: (input) => openMachineSocket({ ...input, callTimeoutMs: 1_000 }) }))
        .rejects.toBeInstanceOf(MachinePairingRequiredError)
    } finally { deadline.clear() }
  })

  it("does not turn a leftover endpoint file into a candidate after the daemon stops", async () => {
    const f = await fixture()
    f.target.root.socket.terminate()
    await f.target.handle.stop()
    const deadline = OperationDeadline.start(1_000)
    try {
      await expect(openWslTransport({ distribution: "Ubuntu", expectedMachineId: f.target.id,
        credential: f.credential, deadline, open: (input) => openMachineSocket({ ...input, callTimeoutMs: 1_000 }) }))
        .rejects.toMatchObject({ name: "WslTransportError", reason: "unreachable" })
    } finally { deadline.clear() }
  })

  it("bounds a real listener that accepts TCP but never speaks and closes its socket", async () => {
    const sockets = new Set<Socket>()
    let accepted = 0
    const server = createServer((socket) => {
      accepted += 1
      sockets.add(socket)
      socket.resume()
      socket.on("close", () => sockets.delete(socket))
    })
    const deadline = OperationDeadline.start(2_000)
    const stop = () => { for (const socket of sockets) socket.destroy(); server.close() }
    deadline.signal.addEventListener("abort", stop, { once: true })
    try {
      await beforeDeadline(new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          if (deadline.remainingMs() === 0) stop()
          resolve()
        })
      }), deadline)
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Listener did not bind")
      vi.spyOn(distributions, "listWslDistributions").mockResolvedValue([
        { name: "Ubuntu", version: 2, state: "Running", default: true },
      ])
      vi.spyOn(endpoints, "readDistroEndpoint").mockResolvedValue({ host: "127.0.0.1", port: address.port, token: "r".repeat(43) })
      const attempt = deadline.limit(500)
      try {
        await expect(openWslTransport({ distribution: "Ubuntu", expectedMachineId: `machine-${"b".repeat(32)}`,
          credential: "p".repeat(43), deadline: attempt, open: (input) => openMachineSocket({ ...input, callTimeoutMs: 1_000 }) }))
          .rejects.toMatchObject({ name: "WslTransportError", reason: "timed-out" })
      } finally { attempt.clear() }
      expect(accepted).toBe(1)
      while (sockets.size > 0) await delay(20, undefined, { signal: deadline.signal })
      expect(sockets.size).toBe(0)
    } finally { stop(); deadline.clear() }
  })

  it("does not let Forget race discovery into another authenticated socket", async () => {
    const f = await fixture()
    let eligible = true
    f.read.mockImplementation(async () => {
      eligible = false
      return { host: f.target.address.host, port: f.target.address.port, token: f.target.handle.authToken }
    })
    const open = vi.fn((input: Parameters<typeof openMachineSocket>[0]) => openMachineSocket(input))
    const dial = createMachineDialer({ machine: () => eligible ? { id: f.target.id, connection: "wsl", transports: [],
      wsl: { distribution: "Ubuntu", version: 2 } } : undefined,
    credentials: asyncTestCredentials(f.source.credentials), wslPlatform: "win32", dialTimeoutMs: 1_000,
    open: (input) => open({ ...input, callTimeoutMs: 1_000 }) })
    await expect(dial(f.target.id)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
})
