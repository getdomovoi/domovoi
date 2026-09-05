import { once } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { arch, platform, tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"
import {
  createEmptyWorkspace, daemonAuthenticationErrorCode, demoWorkspace, devicePairResultSchema,
  fleetMachineDescriptorSchema, protocolVersion, protocolVersionMismatchErrorCode,
} from "@getdomovoi/protocol"

import { DomovoiDaemon } from "./server.js"
import { PairingCodeService } from "./pairing-codes.js"
import { PairingClaimAdmission, pairingClaimWindowMs } from "./pairing-admission.js"
import { SqliteWorkspaceStore } from "./store.js"
import { removeScratchDirectories } from "./test-scratch.js"

const selfId = `machine-${"a".repeat(32)}`
const peerId = `machine-${"b".repeat(32)}`
const roots: string[] = []
const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
let nextId = 0
afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.terminate()
  for (const daemon of daemons.splice(0)) await daemon.stop()
  await removeScratchDirectories(roots.splice(0))
})

async function target() {
  const root = await mkdtemp(join(tmpdir(), "domovoi-machine-admission-"))
  roots.push(root)
  // Facts in the saved snapshot belong to a previous runtime. Heartbeat must
  // describe the running daemon rather than replay that old observation.
  const store = new SqliteWorkspaceStore(join(root, "state.sqlite"), createEmptyWorkspace({
    ...demoWorkspace.machine, id: selfId, name: "old label", platform: "old-platform", arch: "old-arch", version: "0.0.0",
  }))
  const daemon = new DomovoiDaemon({
    port: 0, store, statePath: join(root, "state.sqlite"),
    machineIdentity: { id: selfId, label: "studio" },
  })
  daemons.push(daemon)
  const address = await daemon.start()
  return { daemon, store, url: `ws://127.0.0.1:${address.port}/rpc` }
}

async function open(url: string) {
  const socket = new WebSocket(url)
  sockets.push(socket)
  await once(socket, "open")
  return socket
}

function call(socket: WebSocket, method: string, params: Record<string, unknown> = {}) {
  const id = ++nextId
  return new Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No test reply to ${method}`)) }, 2_000)
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage) }
    const onMessage = (bytes: WebSocket.RawData) => {
      const response = JSON.parse(bytes.toString()) as { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }
      if (response.id === id) { cleanup(); resolve(response) }
    }
    socket.on("message", onMessage)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

async function claim(daemon: DomovoiDaemon, socket: WebSocket) {
  const response = await call(socket, "device.claim", {
    code: daemon.issuePairingCode().code, label: "source laptop", machineId: peerId, protocolVersion,
  })
  return devicePairResultSchema.parse(response.result)
}

async function hello(socket: WebSocket, token: string, client: "machine" | "cli" = "machine") {
  const response = await call(socket, "system.hello", {
    client, clientVersion: "0.0.1", protocolVersion, authToken: token,
  })
  expect(response.error).toBeUndefined()
}

describe("live machine admission", () => {
  it("refuses conflicting durable and canonical machine identities before starting", async () => {
    const store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace({ ...demoWorkspace.machine, id: selfId }))
    try {
      expect(() => new DomovoiDaemon({ port: 0, store, machineIdentity: { id: peerId, label: "studio" } }))
        .toThrow("Stored workspace machine identity does not match this daemon")
      expect(store.load().machine.id).toBe(selfId)
    } finally { await store.close() }
  })

  it("rejects admitted incompatible claims before consuming a code or a guessing attempt", async () => {
    const claim = vi.spyOn(PairingCodeService.prototype, "claim")
    let now = 0
    const admit = PairingClaimAdmission.prototype.admit
    vi.spyOn(PairingClaimAdmission.prototype, "admit").mockImplementation(function (this: PairingClaimAdmission, source) {
      return admit.call(this, source, now)
    })
    const { daemon, store, url } = await target()
    const socket = await open(url)
    const code = daemon.issuePairingCode().code
    for (let index = 0; index < 6; index += 1) {
      // Refill only admission. Real time and the code's expiry do not move.
      // Six incompatible attempts exceed the code's five-guess allowance,
      // but must never reach that separate budget in the pairing service.
      now += pairingClaimWindowMs
      const response = await call(socket, "device.claim", {
        code, label: "source", machineId: peerId, protocolVersion: "0.3.0",
      })
      expect(response.error?.code).toBe(protocolVersionMismatchErrorCode)
      expect(response.error?.data).toEqual({
        kind: "protocol-mismatch", daemonProtocolVersion: protocolVersion, clientProtocolVersion: "0.3.0", compatibility: "machine-ahead",
      })
    }
    expect(claim).not.toHaveBeenCalled()
    expect(store.devices.list()).toEqual([])
    const accepted = await call(socket, "device.claim", { code, label: "source", machineId: peerId, protocolVersion })
    expect(devicePairResultSchema.parse(accepted.result).device.binding).toEqual({ kind: "machine", machineId: peerId })
    expect(claim).toHaveBeenCalledTimes(1)
  })

  it("returns fresh target-authored facts only to an authenticated machine", async () => {
    const { daemon, url } = await target()
    const socket = await open(url)
    const paired = await claim(daemon, socket)
    await hello(socket, paired.token)
    const reply = await call(socket, "fleet.heartbeat")
    const facts = fleetMachineDescriptorSchema.parse(reply.result)
    expect(facts).toMatchObject({ id: selfId, label: "studio", platform: platform(), arch: arch(), version: "0.0.1", protocolVersion })
    expect(facts.transports).toContainEqual({ kind: "local", endpoint: url, authenticated: true })
    expect(facts.capabilities).toContain("worktrees")
    expect(reply.result).not.toHaveProperty("sessions")
    expect(reply.result).not.toHaveProperty("verifiedRoute")
    const client = await open(url)
    await hello(client, daemon.authToken, "cli")
    expect((await call(client, "fleet.heartbeat")).error?.code).toBe(daemonAuthenticationErrorCode)
  })

  it("refuses a machine hello on another protocol with both versions as data", async () => {
    const { daemon, url } = await target()
    const socket = await open(url)
    const paired = await claim(daemon, socket)
    const response = await call(socket, "system.hello", {
      client: "machine", clientVersion: "0.0.1", protocolVersion: "0.3.0", authToken: paired.token,
    })
    expect(response.error).toEqual({
      code: protocolVersionMismatchErrorCode,
      message: `This daemon speaks protocol ${protocolVersion}; the client speaks 0.3.0`,
      data: { kind: "protocol-mismatch", daemonProtocolVersion: protocolVersion, clientProtocolVersion: "0.3.0", compatibility: "machine-ahead" },
    })
    expect((await call(socket, "fleet.heartbeat")).error?.code).toBe(daemonAuthenticationErrorCode)
  })

  it("acknowledges self-revocation before closing the socket and revokes only that credential", async () => {
    const { daemon, store, url } = await target()
    const socket = await open(url)
    const paired = await claim(daemon, socket)
    const other = store.devices.pair({ label: "phone", binding: { kind: "client", client: "phone" } })
    await hello(socket, paired.token)
    const closed = once(socket, "close")
    expect((await call(socket, "device.revokeCurrent")).result).toEqual({ revoked: true })
    await closed
    expect(store.devices.isActive(paired.token)).toBe(false)
    expect(store.devices.isActive(other.token)).toBe(true)
    const client = await open(url)
    await hello(client, daemon.authToken, "cli")
    expect((await call(client, "device.revokeCurrent")).error?.code).toBe(daemonAuthenticationErrorCode)
    expect(store.auditLog.query({ limit: 100 }).entries).toContainEqual(expect.objectContaining({
      action: "device.revokeCurrent", actor: { kind: "machine", machineId: peerId }, target: paired.device.id,
    }))
  })

  it("disconnects the previous machine bearer when a new code replaces its authority", async () => {
    const { daemon, store, url } = await target()
    const previous = await open(url)
    const old = await claim(daemon, previous)
    await hello(previous, old.token)
    const closed = once(previous, "close")
    const replacementSocket = await open(url)
    const replacement = await claim(daemon, replacementSocket)
    await closed
    await hello(replacementSocket, replacement.token)
    expect(store.devices.isActive(old.token)).toBe(false)
    expect(store.devices.isActive(replacement.token)).toBe(true)
  })
})
