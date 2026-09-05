import { on, once } from "node:events"
import { DatabaseSync } from "node:sqlite"

import { protocolVersion, type RpcMethod, type RpcParams } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket } from "ws"

import { SqliteAuditLog, type AuditLog } from "./audit-log.js"
import { OperationDeadline } from "./operation-deadline.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"
import { daemonWaitTimeoutMs } from "./test-wait-for.js"

const daemons: DomovoiDaemon[] = []
const sockets: WebSocket[] = []
const databases: DatabaseSync[] = []
const deadlines: OperationDeadline[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const socket of sockets.splice(0)) socket.terminate()
  const cleanup = OperationDeadline.start(daemonWaitTimeoutMs(process.platform))
  try {
    await within(cleanup, () => Promise.all(daemons.splice(0).map((daemon) => daemon.stop())))
  } finally {
    cleanup.clear()
    for (const deadline of deadlines.splice(0)) deadline.clear()
    for (const database of databases.splice(0)) database.close()
  }
})

function within<T>(deadline: OperationDeadline, operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    deadline.throwIfExpired()
    const detach = () => deadline.signal.removeEventListener("abort", abort)
    const abort = () => { detach(); reject(deadline.signal.reason) }
    deadline.signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => { deadline.throwIfExpired(); return operation() }).then((value) => {
      deadline.throwIfExpired()
      resolve(value)
    }).catch(reject).finally(detach)
  })
}

async function fixture(method: "audit.query" | "audit.export", options: {
  agentTimeoutMs: number
  auditReadTimeoutMs?: number
}) {
  const deadline = OperationDeadline.start(daemonWaitTimeoutMs(process.platform))
  deadlines.push(deadline)
  const database = new DatabaseSync(":memory:")
  databases.push(database)
  const stored = new SqliteAuditLog(database)
  stored.append({ actor: { kind: "client", client: "cli" }, action: "test.audit", outcome: "succeeded" })
  let now = Date.now()
  vi.spyOn(Date, "now").mockImplementation(() => now)
  let readResult: unknown
  let readSignal: AbortSignal | undefined
  // Simulate ten milliseconds spent in a real SQLite read without sleeping or
  // delaying socket timers. This also exercises the check at result settlement.
  const read = <T>(result: T, signal?: AbortSignal) => {
    now += 10
    readResult = result
    readSignal = signal
    return result
  }
  const auditLog: AuditLog = {
    append: (entry) => stored.append(entry),
    query: (params, signal) => read(stored.query(params, signal), signal),
    export: (params, signal) => read(stored.export(params, signal), signal),
  }
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", auditLog, errorSink: () => {}, ...options })
  daemons.push(daemon)
  const address = await within(deadline, () => daemon.start())
  deadline.throwIfExpired()
  const socket = new WebSocket(`ws://${address.host}:${address.port}/rpc`)
  sockets.push(socket)
  await once(socket, "open", { signal: deadline.signal })
  let id = 0
  async function call<M extends RpcMethod>(rpcMethod: M, params: RpcParams<M>) {
    deadline.throwIfExpired()
    const requestId = ++id
    const messages = on(socket, "message", { signal: deadline.signal })
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: rpcMethod, params }))
    for await (const [bytes] of messages) {
      const response = JSON.parse(String(bytes)) as { id: number; result?: unknown; error?: { code: number; message: string } }
      if (response.id === requestId) return response
    }
    throw new Error(`No response to ${rpcMethod}`)
  }
  const hello = await call("system.hello", {
    client: "cli", clientVersion: "audit-deadline-test", protocolVersion, authToken: daemon.authToken,
  })
  expect(hello.error).toBeUndefined()
  const response = await call(method, { limit: 10, ...(method === "audit.export" ? { format: "jsonl" as const } : {}) })
  return { response, readResult, readSignal }
}

describe("audit read deadlines", () => {
  it.each(["audit.query", "audit.export"] as const)("keeps %s independent of the agent deadline", async (method) => {
    const { response, readResult, readSignal } = await fixture(method, { agentTimeoutMs: 5 })
    expect(response.error).toBeUndefined()
    expect(readResult).toBeDefined()
    expect(response.result).toEqual(readResult)
    expect(readSignal?.aborted).toBe(false)
  })

  it.each(["audit.query", "audit.export"] as const)("rejects a late %s result on its own budget", async (method) => {
    const { response, readSignal } = await fixture(method, { agentTimeoutMs: 30_000, auditReadTimeoutMs: 5 })
    expect(response.error).toEqual({ code: -32603, message: `Audit ${method === "audit.query" ? "query" : "export"} timed out` })
    expect(response.result).toBeUndefined()
    expect(readSignal?.aborted).toBe(true)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects invalid audit budgets before loading workspace state: %s", (auditReadTimeoutMs) => {
    const loadStore = vi.spyOn(SqliteWorkspaceStore.prototype, "load")
    expect(() => {
      const daemon = new DomovoiDaemon({ statePath: ":memory:", auditReadTimeoutMs })
      daemons.push(daemon)
    }).toThrow(RangeError)
    expect(loadStore).not.toHaveBeenCalled()
  })
})
