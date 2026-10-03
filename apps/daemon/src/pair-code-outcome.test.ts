import { once } from "node:events"

import {
  deviceCodeOutcomeNotificationSchema,
  devicePairingLimitErrorCode,
  protocolVersion,
  protocolVersionMismatchErrorCode,
  type DeviceCodeOutcomeNotification,
} from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { maximumPairedDevices } from "./device-registry.js"
import { PairingClaimAdmission } from "./pairing-admission.js"
import { PairingCodeService } from "./pairing-codes.js"
import { PairingIssuerSlot } from "./pairing-issuer.js"
import { ResourceMutationQueue } from "./resource-mutation-queue.js"
import { DomovoiDaemon } from "./server.js"
import { waitForDaemon } from "./test-wait-for.js"

// Ruling Q354 A: the window that showed a pairing code learns what became of
// it, redeemed or refused with a reason, and no other connection learns of the
// code. The device spending it keeps the uniform refusal.

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const rpcDeadlineMs = 3_000

beforeEach(() => {
  // Per-source pairing admission is covered in pairing-admission-server.test.ts.
  // Every spend here comes from loopback, so it is admitted here.
  vi.spyOn(PairingClaimAdmission.prototype, "admit").mockReturnValue(true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
})

type Connection = { socket: WebSocket, outcomes: unknown[] }

async function connect(daemon: DomovoiDaemon): Promise<Connection> {
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  const outcomes: unknown[] = []
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { method?: string, params?: unknown }
    if (message.method === "device.codeOutcome") outcomes.push(message.params)
  })
  await once(socket, "open", { signal: AbortSignal.timeout(rpcDeadlineMs) })
  return { socket, outcomes }
}

let nextId = 1
function call(connection: Connection, method: string, params: Record<string, unknown>) {
  const { socket } = connection
  const id = nextId++
  return new Promise<{ result?: unknown, error?: { code: number, message: string } }>((resolve, reject) => {
    const timer = setTimeout(() => settle(() => reject(new Error(`${method} deadline expired`))), rpcDeadlineMs)
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      socket.off("message", receive)
      finish()
    }
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { id?: number }
      if (message.id === id) settle(() => resolve(message as { result?: unknown, error?: { code: number, message: string } }))
    }
    socket.on("message", receive)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

async function start() {
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
  daemons.push(daemon)
  await daemon.start()
  return daemon
}

async function owner(daemon: DomovoiDaemon, client = "desktop") {
  const connection = await connect(daemon)
  expect((await call(connection, "system.hello", {
    client, clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
  })).error).toBeUndefined()
  return connection
}

async function issue(connection: Connection, params: Record<string, unknown> = { targetClient: "phone" }) {
  const issued = await call(connection, "device.issueCode", params)
  expect(issued.error).toBeUndefined()
  return issued.result as { pairingId: string, code: string }
}

function redeem(connection: Connection, code: string, label = "iPhone 16 Pro", version: string = protocolVersion) {
  return call(connection, "device.redeemCode", { code, label, protocolVersion: version })
}

// A notification that is going to arrive arrives before a later reply on the
// same socket, so one round trip after the spend is enough to see silence.
async function settled(connection: Connection) {
  expect((await call(connection, "device.current", {})).error).toBeUndefined()
}

// Holds the next exclusive request (device.issueCode is one) behind a mutation
// that runs until release is called.
function holdNextExclusive() {
  let release!: () => void
  const blocker = new Promise<void>((resolve) => { release = resolve })
  const enqueueExclusive = ResourceMutationQueue.prototype.enqueueExclusive
  const queued = vi.spyOn(ResourceMutationQueue.prototype, "enqueueExclusive")
    .mockImplementationOnce(function (this: ResourceMutationQueue, task, options) {
      void enqueueExclusive.call(this, () => blocker)
      return enqueueExclusive.call(this, task, options)
    })
  return { queued, release }
}

function only(outcomes: unknown[]): DeviceCodeOutcomeNotification {
  expect(outcomes).toHaveLength(1)
  return deviceCodeOutcomeNotificationSchema.parse(outcomes[0])
}

describe("the window that issued a client code", () => {
  it("learns which device redeemed it, and nobody else hears of it", async () => {
    const daemon = await start()
    const issuer = await owner(daemon)
    const bystander = await owner(daemon, "cli")
    const { pairingId, code } = await issue(issuer)

    const phone = await connect(daemon)
    const redeemed = await redeem(phone, code)
    expect(redeemed.error).toBeUndefined()
    const { device, token } = redeemed.result as { device: { id: string }, token: string }

    await waitForDaemon(async () => expect(issuer.outcomes).toHaveLength(1))
    expect(only(issuer.outcomes)).toEqual({
      pairingId,
      outcome: "redeemed",
      device: expect.objectContaining({
        id: device.id,
        label: "iPhone 16 Pro",
        binding: { kind: "client", client: "phone", clientAccess: "full" },
      }),
    })
    expect(JSON.stringify(issuer.outcomes)).not.toContain(token)
    expect(JSON.stringify(issuer.outcomes)).not.toContain(code)
    await settled(bystander)
    expect(bystander.outcomes).toEqual([])
    expect(phone.outcomes).toEqual([])
  })

  it("learns that a device on another protocol was refused, and the code still pairs", async () => {
    const daemon = await start()
    const issuer = await owner(daemon)
    const { pairingId, code } = await issue(issuer)

    const older = await connect(daemon)
    const refused = await redeem(older, code, "old iPhone", "0.7.0")
    expect(refused.error?.code).toBe(protocolVersionMismatchErrorCode)
    // A device on another protocol presenting some other code is nobody's business.
    const stranger = await connect(daemon)
    expect((await redeem(stranger, "wrong-wrong-wrong-11", "stranger", "0.7.0")).error?.code).toBe(protocolVersionMismatchErrorCode)

    await waitForDaemon(async () => expect(issuer.outcomes).toHaveLength(1))
    await settled(issuer)
    expect(only(issuer.outcomes)).toEqual({
      pairingId,
      outcome: "refused",
      reason: "protocol-mismatch",
      label: "old iPhone",
      daemonProtocolVersion: protocolVersion,
      clientProtocolVersion: "0.7.0",
      compatibility: "machine-ahead",
    })
    expect(older.outcomes).toEqual([])

    const updated = await connect(daemon)
    expect((await redeem(updated, code)).error).toBeUndefined()
    await waitForDaemon(async () => expect(issuer.outcomes).toHaveLength(2))
    expect(deviceCodeOutcomeNotificationSchema.parse(issuer.outcomes[1])).toMatchObject({ pairingId, outcome: "redeemed" })
  })

  // Security review r1 P3: the code is matched only after the refusal has been
  // written, so the refusal's latency cannot depend on whether the code is live.
  it("writes the mismatch refusal before it looks at the code", async () => {
    const daemon = await start()
    const issuer = await owner(daemon)
    const { code } = await issue(issuer)
    const events: string[] = []
    const send = WebSocket.prototype.send
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data: unknown, ...rest: unknown[]) {
      // The redeemer's refusal, not the issuer's notification, which names the
      // same reason.
      if (typeof data === "string" && data.includes("\"error\"") && data.includes("\"protocol-mismatch\"")) events.push("refusal written")
      return (send as (...args: unknown[]) => void).call(this, data, ...rest)
    })
    const match = PairingCodeService.prototype.matchingPairing
    vi.spyOn(PairingCodeService.prototype, "matchingPairing").mockImplementation(function (this: PairingCodeService, ...args) {
      events.push("code matched")
      return match.apply(this, args)
    })

    const older = await connect(daemon)
    expect((await redeem(older, code, "old iPhone", "0.7.0")).error?.code).toBe(protocolVersionMismatchErrorCode)
    await waitForDaemon(async () => expect(issuer.outcomes).toHaveLength(1))
    expect(events).toEqual(["refusal written", "code matched"])
  })

  it("learns that the device list was full, with the refused device's label", async () => {
    const daemon = await start()
    const issuer = await owner(daemon)
    for (let index = 0; index < maximumPairedDevices; index += 1) {
      expect((await call(issuer, "device.pair", { label: `device ${index}`, client: "desktop", targetClient: "web" })).error).toBeUndefined()
    }
    const { pairingId, code } = await issue(issuer)

    const phone = await connect(daemon)
    expect((await redeem(phone, code, "iPad Pro")).error?.code).toBe(devicePairingLimitErrorCode)
    await waitForDaemon(async () => expect(issuer.outcomes).toHaveLength(1))
    expect(only(issuer.outcomes)).toEqual({ pairingId, outcome: "refused", reason: "device-limit", label: "iPad Pro" })
    expect(phone.outcomes).toEqual([])
  })

  it("learns that wrong codes used up its attempts, once, with no guess's label", async () => {
    const daemon = await start()
    const issuer = await owner(daemon)
    const { pairingId, code } = await issue(issuer)

    const guesser = await connect(daemon)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await redeem(guesser, "wrong-wrong-wrong-11", `guess ${attempt}`)).error?.message).toBe("Pairing was refused")
    }
    expect((await redeem(guesser, code)).error?.message).toBe("Pairing was refused")
    await waitForDaemon(async () => expect(issuer.outcomes).toHaveLength(1))
    await settled(issuer)
    expect(only(issuer.outcomes)).toEqual({ pairingId, outcome: "closed", reason: "attempts-exhausted" })
    expect(guesser.outcomes).toEqual([])
  })

  it("learns that another code replaced it, and nothing about the new code", async () => {
    const daemon = await start()
    const first = await owner(daemon)
    const second = await owner(daemon)
    const replaced = await issue(first)
    const current = await issue(second)

    await waitForDaemon(async () => expect(first.outcomes).toHaveLength(1))
    expect(only(first.outcomes)).toEqual({ pairingId: replaced.pairingId, outcome: "closed", reason: "replaced" })

    const phone = await connect(daemon)
    expect((await redeem(phone, current.code)).error).toBeUndefined()
    await waitForDaemon(async () => expect(second.outcomes).toHaveLength(1))
    expect(only(second.outcomes)).toMatchObject({ pairingId: current.pairingId, outcome: "redeemed" })
    await settled(first)
    expect(first.outcomes).toHaveLength(1)
    expect(JSON.stringify(first.outcomes)).not.toContain(current.pairingId)
  })

  it("learns that its code was spent as a machine pairing", async () => {
    const daemon = await start()
    const issuer = await owner(daemon)
    const { pairingId, code } = await issue(issuer)

    const machine = await connect(daemon)
    const claimed = await call(machine, "device.claim", {
      code, label: "a machine", machineId: `machine-${"a".repeat(32)}`, protocolVersion,
    })
    expect(claimed.error?.message).toBe("Pairing was refused")
    await waitForDaemon(async () => expect(issuer.outcomes).toHaveLength(1))
    expect(only(issuer.outcomes)).toEqual({ pairingId, outcome: "refused", reason: "wrong-kind" })
  })
})

describe("a code issued without a client kind", () => {
  it("reports nothing to its issuer, so a machine claim's flow is unchanged", async () => {
    const daemon = await start()
    const issuer = await owner(daemon)
    const { code } = await issue(issuer, {})

    const phone = await connect(daemon)
    expect((await redeem(phone, code)).error?.message).toBe("Pairing was refused")
    await settled(issuer)
    expect(issuer.outcomes).toEqual([])
  })
})

describe("an issuer that has gone", () => {
  it("is not written to, and the device still pairs", async () => {
    const daemon = await start()
    const issuer = await owner(daemon)
    const { code } = await issue(issuer)
    issuer.socket.close()
    await once(issuer.socket, "close")

    const phone = await connect(daemon)
    expect((await redeem(phone, code)).error).toBeUndefined()
    expect(issuer.outcomes).toEqual([])
  })

  // Security review r2 P3: an issuance queued behind a mutation can run after
  // its connection closed, and that close has already let the slot go.
  it("is not held when its queued issuance runs after it closed", async () => {
    const daemon = await start()
    const issuer = await owner(daemon)
    const { queued, release } = holdNextExclusive()
    const forget = vi.spyOn(PairingIssuerSlot.prototype, "forget")
    const set = vi.spyOn(PairingIssuerSlot.prototype, "set")
    const issued = vi.spyOn(PairingCodeService.prototype, "issue")

    issuer.socket.send(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "device.issueCode", params: { targetClient: "phone" } }))
    await waitForDaemon(async () => expect(queued).toHaveBeenCalled())
    issuer.socket.close()
    await waitForDaemon(async () => expect(forget).toHaveBeenCalled())
    release()
    await waitForDaemon(async () => expect(issued).toHaveBeenCalledTimes(1))

    // set takes the slot and starts its expiry timer.
    expect(set).not.toHaveBeenCalled()
    expect((forget.mock.contexts[0] as PairingIssuerSlot<unknown>).current).toBeUndefined()
  })
})
