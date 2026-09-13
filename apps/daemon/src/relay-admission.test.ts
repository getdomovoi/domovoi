import { once } from "node:events"
import { createEmptyWorkspace, demoWorkspace, protocolVersion } from "@getdomovoi/protocol"
import { createRelayClient, relayPublicKeyFromPrivateKey, type RelayClient } from "@getdomovoi/protocol/relay-admission"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PairingCodeService } from "./pairing-codes.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import type { TerminalProcess } from "./terminal.js"
import { waitForDaemon } from "./test-wait-for.js"

const key = new Uint8Array(32).fill(11)
const otherKey = new Uint8Array(32).fill(13)
const daemonKey = new Uint8Array(32).fill(12)
const daemons: DomovoiDaemon[] = []
const clients: RelayClient[] = []
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  vi.restoreAllMocks()
})

async function fixture(relayEnabled = true) {
  const store = new SqliteWorkspaceStore(":memory:", createEmptyWorkspace(demoWorkspace.machine))
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", store, ...(relayEnabled ? { relayStaticKey: daemonKey } : {}), errorSink: vi.fn() })
  daemons.push(daemon)
  await daemon.start()
  const paired = store.devices.pair({ label: "phone", binding: { kind: "client", client: "phone" }, channelPublicKey: relayPublicKeyFromPrivateKey(key) })
  return { daemon, store, paired }
}

function connect(daemon: DomovoiDaemon, token: string, staticPrivateKey = key) {
  const upstream: Uint8Array[] = [], downstream: Uint8Array[] = [], wire: Uint8Array[] = []
  const messages: Array<Record<string, unknown>> = []
  const context = { relayProtocol: 1 as const, routeId: Buffer.alloc(32, 9).toString("base64url"),
    channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: relayPublicKeyFromPrivateKey(daemonKey) } }
  const ingress = daemon.openRelayChannel({ context,
    carrier: { bufferedAmount: 0, send: (frame) => { downstream.push(frame); wire.push(frame.slice()) }, close: () => client?.close() } })
  const client = createRelayClient({ context, token, staticPrivateKey,
    carrier: { bufferedAmount: 0, send: (frame) => { upstream.push(frame); wire.push(frame.slice()) }, close: () => ingress?.close() },
    onMessage: (message) => messages.push(JSON.parse(message) as Record<string, unknown>) })
  clients.push(client)
  const pump = () => {
    for (let count = 0; upstream.length + downstream.length > 0; count++) {
      if (count > 512) throw new Error("Unbounded relay fixture exchange")
      const request = upstream.shift()
      if (request && !ingress!.closed) ingress!.receive(request)
      const response = downstream.shift()
      if (response && !client!.closed) client!.receive(response)
    }
  }
  client.start(); pump()
  let id = 0
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const requestId = ++id
    client!.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    await waitForDaemon(() => { pump(); expect(messages.some((message) => message.id === requestId)).toBe(true) })
    return messages.find((message) => message.id === requestId)!
  }
  const hello = (extra: Record<string, unknown> = {}) => rpc("system.hello", { client: "phone", clientVersion: "0.0.1", protocolVersion, ...extra })
  return { client, ingress, messages, wire, pump, rpc, hello }
}

async function direct(daemon: DomovoiDaemon) {
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.address!.port}/rpc`, { headers: { authorization: `Bearer ${daemon.authToken}` } })
  sockets.push(socket)
  await once(socket, "open", { signal: AbortSignal.timeout(10_000) })
  let id = 0
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const result = once(socket, "message", { signal: AbortSignal.timeout(10_000) })
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }))
    const [data] = await result as [WebSocket.RawData]
    return JSON.parse(data.toString()) as Record<string, unknown>
  }
  await rpc("system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion })
  return rpc
}

describe("daemon relay admission", () => {
  it("uses the paired identity for hello, activity and ordinary RPC", async () => {
    const { daemon, store, paired } = await fixture()
    const relay = connect(daemon, paired.token)
    expect(relay.client.admitted).toBe(true)
    expect(store.devices.verify(paired.token)?.device.lastSeenAt).toBeUndefined()
    expect(await relay.hello()).toHaveProperty("result")
    expect(store.devices.verify(paired.token)?.device.lastSeenAt).toBeDefined()
    expect(await relay.rpc("device.current")).toMatchObject({ result: { kind: "client", deviceId: paired.device.id, client: "phone" } })
    expect(await relay.rpc("workspace.get")).toHaveProperty("result")
    expect(relay.wire.some((frame) => Buffer.from(frame).includes(Buffer.from(paired.token)))).toBe(false)
  })

  it.each(["root", "legacy", "wrong-key", "other-device", "revoked", "rotated", "pending"] as const)("refuses %s authority before hello or daemon output", async (kind) => {
    const { daemon, store, paired } = await fixture()
    let token = paired.token
    let privateKey = key
    if (kind === "root") token = daemon.authToken
    if (kind === "legacy") token = store.devices.pair({ label: "old", binding: { kind: "client", client: "phone" } }).token
    if (kind === "wrong-key") privateKey = otherKey
    if (kind === "other-device") token = store.devices.pair({ label: "other", binding: { kind: "client", client: "phone" }, channelPublicKey: relayPublicKeyFromPrivateKey(otherKey) }).token
    if (kind === "revoked") store.devices.revoke(paired.device.id)
    if (kind === "rotated") store.devices.rotate(paired.device.id)
    if (kind === "pending") token = store.devices.claim({ label: "pending", machineId: `machine-${"a".repeat(32)}`, channelPublicKey: relayPublicKeyFromPrivateKey(key) }, Date.now()).token
    const relay = connect(daemon, token, privateKey)
    expect(relay.client.closed).toBe(true)
    expect(relay.messages).toEqual([])
  })

  it("never opens pairing or artifact HTTP access over a relay channel", async () => {
    const { daemon, paired } = await fixture()
    const claim = vi.spyOn(PairingCodeService.prototype, "claim")
    const relay = connect(daemon, paired.token)
    await relay.hello()
    for (const method of ["device.pair", "device.claim", "device.confirmClaim", "device.issueCode", "artifact.authorize"]) {
      expect(await relay.rpc(method)).toMatchObject({ error: { message: "This method requires a direct connection" } })
    }
    expect(claim).not.toHaveBeenCalled()
  })

  it("does not accept a second bearer in hello", async () => {
    const { daemon, paired } = await fixture()
    const relay = connect(daemon, paired.token)
    expect(await relay.hello({ authToken: daemon.authToken })).toMatchObject({ error: { message: "Relay credentials belong only in the admission record" } })
    expect(await relay.rpc("device.current")).toHaveProperty("error")
  })

  it.each(["device.revoke", "device.rotate"])("%s closes a listening relay immediately", async (method) => {
    const { daemon, paired } = await fixture()
    const relay = connect(daemon, paired.token)
    await relay.hello()
    const rpc = await direct(daemon)
    expect(await rpc(method, { deviceId: paired.device.id, client: "cli" })).toHaveProperty("result")
    expect(relay.client.closed).toBe(true)
  })

  it("refuses a copied bearer through root-only management and a mismatched client hello", async () => {
    const { daemon, paired } = await fixture()
    const relay = connect(daemon, paired.token)
    expect(await relay.hello({ client: "web" })).toHaveProperty("error")
    expect(await relay.hello()).toHaveProperty("result")
    expect(await relay.rpc("device.rotate", { deviceId: paired.device.id, client: "phone" })).toHaveProperty("error")
  })
})


describe("direct relay enrolment", () => {
  it("binds an opted-in client key and returns the daemon pin only on opt-in", async () => {
    const { daemon, store } = await fixture()
    const rpc = await direct(daemon)
    const ordinary = await rpc("device.pair", { client: "cli", targetClient: "phone", label: "ordinary" })
    expect(ordinary).toHaveProperty("result")
    expect(ordinary.result).not.toHaveProperty("relay")
    const response = await rpc("device.pair", { client: "cli", targetClient: "phone", label: "relay phone", channelPublicKey: relayPublicKeyFromPrivateKey(key) })
    expect(response).toMatchObject({ result: { relay: { suite: "Noise_IK_25519_ChaChaPoly_SHA256", responderPublicKey: relayPublicKeyFromPrivateKey(daemonKey) } } })
    const result = response.result as { token: string }
    expect(store.devices.verify(result.token)?.channelPublicKey).toBe(relayPublicKeyFromPrivateKey(key))
    expect(connect(daemon, result.token).client.admitted).toBe(true)
  })

  it("keeps a claimed key pending until direct confirmation", async () => {
    const { daemon, store } = await fixture()
    const rpc = await direct(daemon)
    const issued = await rpc("device.issueCode")
    const code = (issued.result as { code: string }).code
    const machineId = `machine-${"a".repeat(32)}`
    const response = await rpc("device.claim", { code, label: "source", machineId, protocolVersion, channelPublicKey: relayPublicKeyFromPrivateKey(key) })
    expect(response).toMatchObject({ result: { relay: { responderPublicKey: relayPublicKeyFromPrivateKey(daemonKey) } } })
    const token = (response.result as { token: string }).token
    expect(store.devices.verify(token)).toBeUndefined()
    expect(await rpc("device.confirmClaim", { authToken: token, machineId, protocolVersion })).toHaveProperty("result")
    expect(store.devices.verify(token)?.channelPublicKey).toBe(relayPublicKeyFromPrivateKey(key))
    expect(await connect(daemon, token).hello({ client: "machine" })).toHaveProperty("result")
  })

  it("refuses an unavailable pin before minting credentials or spending a code", async () => {
    const { daemon, store } = await fixture(false)
    const pair = vi.spyOn(store.devices, "pair")
    const claim = vi.spyOn(PairingCodeService.prototype, "claim")
    const rpc = await direct(daemon)
    const issued = await rpc("device.issueCode")
    const code = (issued.result as { code: string }).code
    const machineId = `machine-${"a".repeat(32)}`
    for (const [method, params] of [
      ["device.pair", { client: "cli", label: "phone" }],
      ["device.claim", { code, label: "source", machineId, protocolVersion }],
    ] as const) {
      expect(await rpc(method, { ...params, channelPublicKey: relayPublicKeyFromPrivateKey(key) })).toMatchObject({ error: { message: "Relay admission is unavailable" } })
    }
    expect(pair).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
    expect(await rpc("device.claim", { code, label: "source", machineId, protocolVersion })).toHaveProperty("result")
  })
})


describe("relay carrier lifecycle", () => {
  it("closes a refused carrier without leaking cleanup errors", async () => {
    const { daemon } = await fixture(false)
    const close = vi.fn(() => { throw new Error("carrier secret") })
    expect(() => daemon.openRelayChannel({ context: {} as never, carrier: { bufferedAmount: 0, send: vi.fn(), close } })).toThrow(/^Relay admission is unavailable$/)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("bounds unfinished channels and releases slots on refusal, close and shutdown", async () => {
    const { daemon } = await fixture()
    const context = { relayProtocol: 1 as const, routeId: Buffer.alloc(32, 9).toString("base64url"), channel: { suite: "Noise_IK_25519_ChaChaPoly_SHA256" as const, responderPublicKey: relayPublicKeyFromPrivateKey(daemonKey) } }
    const closed = vi.fn()
    const open = () => daemon.openRelayChannel({ context, carrier: { bufferedAmount: 0, send: vi.fn(), close: closed } })
    const opened = Array.from({ length: 32 }, open)
    expect(() => open()).toThrow("Relay admission is unavailable")
    opened[0]!.receive(new Uint8Array(1))
    expect(opened[0]!.closed).toBe(true)
    const replacement = open()
    opened[1]!.close()
    const last = open()
    await daemon.stop()
    expect([...opened, replacement, last].every((channel) => channel.closed)).toBe(true)
    expect(() => open()).toThrow("Relay admission is unavailable")
    expect(closed).toHaveBeenCalledTimes(36)
  })

  it("closes invalid context once before reserving a channel slot", async () => {
    const { daemon } = await fixture()
    const close = vi.fn()
    expect(() => daemon.openRelayChannel({ context: {} as never, carrier: { bufferedAmount: 0, send: vi.fn(), close } })).toThrow("Relay admission is unavailable")
    expect(close).toHaveBeenCalledTimes(1)
  })
})


describe("relay dispatcher inheritance", () => {
  it("refuses a changed identity or unavailable registry on an already admitted channel", async () => {
    for (const kind of ["device", "binding", "key", "throw"] as const) {
      const { daemon, store, paired } = await fixture()
      const relay = connect(daemon, paired.token)
      await relay.hello()
      const verified = store.devices.verify(paired.token)!
      const verify = vi.spyOn(store.devices, "verify")
      if (kind === "throw") verify.mockImplementation(() => { throw new Error("storage secret") })
      else verify.mockReturnValue({ ...verified,
        ...(kind === "device" ? { device: { ...verified.device, id: `device-${"e".repeat(32)}` } } : {}),
        ...(kind === "binding" ? { binding: { kind: "client", client: "web" } as const } : {}),
        ...(kind === "key" ? { channelPublicKey: relayPublicKeyFromPrivateKey(otherKey) } : {}),
      })
      const before = relay.messages.length
      relay.client.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "workspace.get", params: {} }))
      relay.pump()
      expect(relay.client.closed).toBe(true)
      expect(relay.messages).toHaveLength(before)
      verify.mockRestore()
    }
  })

  it("keeps terminal writes owned by the admitted socket and reaps after channel close", async () => {
    const snapshot = structuredClone(demoWorkspace)
    for (const session of snapshot.sessions) { session.state = "idle"; delete session.activeTurnId }
    const session = snapshot.sessions[0]!
    session.workspacePath = process.cwd()
    snapshot.approvals = []
    let emit: ((data: string) => void) | undefined
    const terminal = { process: "test-shell", write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: (callback: (data: string) => void) => { emit = callback; return { dispose: vi.fn() } },
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } satisfies TerminalProcess
    const store = new SqliteWorkspaceStore(":memory:", snapshot)
    const daemon = new DomovoiDaemon({ port: 0, store, relayStaticKey: daemonKey, terminalService: { spawn: () => terminal }, terminalReapGraceMs: 1, errorSink: vi.fn() })
    daemons.push(daemon); await daemon.start()
    const paired = store.devices.pair({ label: "phone", binding: { kind: "client", client: "phone" }, channelPublicKey: relayPublicKeyFromPrivateKey(key) })
    const owner = connect(daemon, paired.token), other = connect(daemon, paired.token)
    await owner.hello(); await other.hello()
    const terminalId = "terminal-relay-proof"
    expect(await owner.rpc("terminal.create", { terminalId, sessionId: session.id, cols: 80, rows: 24, client: "phone", clientId: paired.device.id })).toHaveProperty("result")
    expect(await owner.rpc("terminal.input", { terminalId, data: "owned", client: "phone", clientId: paired.device.id })).toHaveProperty("result")
    expect(terminal.write).toHaveBeenCalledWith("owned")
    expect(await other.rpc("terminal.input", { terminalId, data: "not owned", client: "phone", clientId: paired.device.id })).toHaveProperty("error")
    expect(terminal.write).toHaveBeenCalledTimes(1)
    emit!("terminal output")
    await waitForDaemon(() => { owner.pump(); expect(owner.messages.some((message) => message.method === "terminal.output")).toBe(true) })
    expect(owner.wire.some((frame) => Buffer.from(frame).includes(Buffer.from("terminal output")))).toBe(false)
    owner.client.close()
    await waitForDaemon(() => expect(terminal.kill).toHaveBeenCalledTimes(1))
  })
})
