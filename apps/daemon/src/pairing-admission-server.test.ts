import { once } from "node:events"
import { DatabaseSync } from "node:sqlite"

import { protocolVersion } from "@getdomovoi/protocol"
import { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SqliteAuditLog } from "./audit-log.js"
import { PairingCodeService } from "./pairing-codes.js"
import { PairingClaimAdmission } from "./pairing-admission.js"
import { DomovoiDaemon } from "./server.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const databases: DatabaseSync[] = []
const rpcDeadlineMs = 3_000

afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.terminate()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  for (const database of databases.splice(0)) database.close()
})

async function connect(daemon: DomovoiDaemon, headers?: Record<string, string>) {
  const signal = AbortSignal.timeout(rpcDeadlineMs)
  const address = daemon.address!
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`, { headers })
  sockets.push(socket)
  try {
    await once(socket, "open", { signal })
  } catch (error) {
    socket.terminate()
    throw error
  }
  return socket
}

function call(socket: WebSocket, id: number, method: string, params: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => settle(() => reject(new Error(`${method} deadline expired`))), rpcDeadlineMs)
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      socket.off("message", receive)
      socket.off("close", closed)
      socket.off("error", failed)
      finish()
    }
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>
      if (message.id === id) settle(() => resolve(message))
    }
    const closed = () => settle(() => reject(new Error(`${method} connection closed`)))
    const failed = (error: Error) => settle(() => reject(error))
    socket.on("message", receive)
    socket.once("close", closed)
    socket.once("error", failed)
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  })
}

describe("pairing admission over the daemon socket", () => {
  it("cannot evict an authenticated decision by submitting rejected claims", async () => {
    const database = new DatabaseSync(":memory:")
    databases.push(database)
    const audit = new SqliteAuditLog(database, { maximumEntries: 3 })
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", auditLog: audit })
    daemons.push(daemon)
    await daemon.start()
    const owner = await connect(daemon)
    expect(await call(owner, 1, "system.hello", {
      client: "cli",
      clientVersion: "0.0.1",
      protocolVersion,
      authToken: daemon.authToken,
    })).not.toHaveProperty("error")
    expect(await call(owner, 2, "device.issueCode", {})).not.toHaveProperty("error")
    const issued = audit.query({ action: "device.issueCode" }).entries
    expect(issued).toHaveLength(1)
    expect(issued[0]?.actor).toMatchObject({ kind: "client", client: "cli" })

    const attacker = await connect(daemon)
    for (let id = 1; id <= 4; id += 1) {
      expect(await call(attacker, id, "device.claim", {
        code: "wrong-wrong-wrong-11",
        machineId: `machine-${"a".repeat(32)}`,
        label: "untrusted-label",
      })).toMatchObject({ error: { message: "Pairing was refused" } })
    }

    expect(audit.query({ action: "device.issueCode" }).entries).toEqual(issued)
    expect(audit.query({ action: "device.claim" }).entries.length).toBeGreaterThan(0)
    const exported = audit.export().content
    expect(exported).not.toContain("wrong-wrong-wrong-11")
    expect(exported).not.toContain("untrusted-label")
    expect(exported).not.toContain(daemon.authToken)
  })

  it("limits the source across reconnects and forwarded headers before checking the code", async () => {
    const claim = vi.spyOn(PairingCodeService.prototype, "claim")
    // Change only the limiter's monotonic clock. All sockets, code checks,
    // credential writes and responses still use the real daemon path.
    let now = 0
    const admit = PairingClaimAdmission.prototype.admit
    vi.spyOn(PairingClaimAdmission.prototype, "admit").mockImplementation(function (this: PairingClaimAdmission, source) {
      return admit.call(this, source, now)
    })
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const socket = await connect(daemon, { "x-forwarded-for": `192.0.2.${attempt + 1}` })
      expect(await call(socket, 1, "device.claim", {
        code: "wrong-wrong-wrong-11",
        machineId: `machine-${"a".repeat(32)}`,
        label: "guess",
      })).toMatchObject({ error: { message: "Pairing was refused" } })
      socket.terminate()
    }

    // Issuing a fresh code must not reset admission, and a valid code must not
    // be spent when a source has exhausted its allowance.
    const issued = daemon.issuePairingCode()
    const socket = await connect(daemon, {
      "x-forwarded-for": "198.51.100.20",
      forwarded: "for=198.51.100.21",
      "x-real-ip": "198.51.100.22",
    })
    const closed: Array<{ code: number; reason: string }> = []
    socket.on("close", (code, reason) => closed.push({ code, reason: reason.toString() }))
    expect(await call(socket, 1, "device.claim", {
      code: issued.code,
      machineId: `machine-${"b".repeat(32)}`,
      label: "must-not-be-paired",
    })).toMatchObject({ error: { message: "Pairing was refused" } })
    expect(claim).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => expect(closed).toEqual([
      { code: 1008, reason: "pairing rate limit" },
    ]), { timeout: rpcDeadlineMs })

    now = 60_000
    const retry = await connect(daemon)
    const paired = await call(retry, 1, "device.claim", {
      code: issued.code,
      machineId: `machine-${"b".repeat(32)}`,
      label: "paired-after-cooldown",
    })
    expect(paired).not.toHaveProperty("error")
    expect(paired).toHaveProperty("result.device.label", "paired-after-cooldown")
    expect(claim).toHaveBeenCalledTimes(4)
  })

  it("counts malformed claims without passing them to the pairing service", async () => {
    const claim = vi.spyOn(PairingCodeService.prototype, "claim")
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const issued = daemon.issuePairingCode()
    const socket = await connect(daemon)
    for (let id = 1; id <= 3; id += 1) {
      expect(await call(socket, id, "device.claim", {}))
        .toMatchObject({ error: { code: -32602 } })
    }
    expect(await call(socket, 4, "device.claim", {
      code: issued.code,
      machineId: `machine-${"a".repeat(32)}`,
      label: "must-not-be-paired",
    })).toMatchObject({ error: { message: "Pairing was refused" } })
    expect(claim).not.toHaveBeenCalled()
  })

  it("does not exempt a credential-bearing socket from claim admission", async () => {
    const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
    daemons.push(daemon)
    await daemon.start()
    const issued = daemon.issuePairingCode()
    const attacker = await connect(daemon)
    for (let id = 1; id <= 3; id += 1) await call(attacker, id, "device.claim", {})

    const owner = await connect(daemon, { authorization: `Bearer ${daemon.authToken}` })
    expect(await call(owner, 1, "system.hello", {
      client: "cli",
      clientVersion: "0.0.1",
      protocolVersion,
    })).not.toHaveProperty("error")
    expect(await call(owner, 2, "device.claim", {
      code: issued.code,
      machineId: `machine-${"a".repeat(32)}`,
      label: "must-not-be-paired",
    })).toMatchObject({ error: { message: "Pairing was refused" } })
  })
})
