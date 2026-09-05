import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEmptyWorkspace, demoWorkspace, protocolVersion, protocolVersionMismatchErrorCode } from "@getdomovoi/protocol"
import { WebSocketServer, type WebSocket } from "ws"
import { afterEach, expect, it, vi } from "vitest"

import { acquireLocalDaemon } from "./local-daemon.js"
import { localOwnerProof } from "./local-owner-proof.js"
import { readLocalOwnerRecord, readLocalOwnerSecret, writeLocalOwnerRecord, type ReadyLocalOwner } from "./local-owner-record.js"
import * as ownerRecords from "./local-owner-record.js"
import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"
import { createProductionDaemonWithDependencies, productionDaemonDependencies } from "./production-daemon.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const finish of cleanup.splice(0).reverse()) await finish()
})

async function peer(options: { proof?: "missing" | "wrong" | "replayed"; response?: "silent" | "identity" | "auth" | "protocol" | "record-changed" } = {}) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-discovery-peer-"))
  cleanup.push(() => rm(homeDirectory, { recursive: true, force: true }))
  const deadline = OperationDeadline.start(3_000)
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  cleanup.push(async () => {
    for (const client of server.clients) client.terminate()
    const closing = OperationDeadline.start(3_000)
    try { await beforeDeadline(new Promise<void>((resolve) => server.close(() => resolve())), closing) } finally { closing.clear() }
  })
  try { await once(server, "listening", { signal: deadline.signal }) } finally { deadline.clear() }
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing peer address")
  const owner = await createProductionDaemonWithDependencies({ homeDirectory, environment: {} }, {
    ...productionDaemonDependencies,
    createDaemon: (input) => ({
      host: address.address, requestedPort: address.port, authToken: input.authToken!,
      start: async () => ({ host: address.address, port: address.port }), stop: async () => {},
    }),
  })
  cleanup.push(() => owner.stop())
  await owner.start()
  const record = readLocalOwnerRecord(homeDirectory) as ReadyLocalOwner
  const secret = readLocalOwnerSecret(homeDirectory)
  const requests: unknown[] = []
  const headers: import("node:http").IncomingHttpHeaders[] = []
  let received: (() => void) | undefined
  const observed = new Promise<void>((resolve) => { received = resolve })
  let connection: WebSocket | undefined
  server.on("headers", (lines, request) => {
    headers.push(request.headers)
    if (options.proof === "missing") return
    const nonce = options.proof === "replayed" ? randomBytes(32).toString("base64url") : String(request.headers["x-domovoi-owner-nonce"])
    const proof = options.proof === "wrong" ? randomBytes(32).toString("base64url") : localOwnerProof(secret, record, nonce)
    lines.push(`X-Domovoi-Owner-Proof: ${proof}`)
  })
  server.on("connection", (socket) => {
    connection = socket
    socket.on("message", (bytes) => {
      requests.push(JSON.parse(bytes.toString()))
      received?.()
      if (options.response === "silent") return
      if (options.response === "record-changed") {
        const { url: _url, ...identity } = record
        writeLocalOwnerRecord(homeDirectory, { ...identity, state: "stopping" })
      }
      socket.send(JSON.stringify(options.response === "auth" || options.response === "protocol"
        ? { jsonrpc: "2.0", id: 1, error: { code: options.response === "auth" ? -32001 : protocolVersionMismatchErrorCode, message: "refused" } }
        : { jsonrpc: "2.0", id: 1, result: createEmptyWorkspace({
          ...demoWorkspace.machine, id: options.response === "identity" ? "different-machine" : record.machineId,
        }) }))
    })
  })
  return { homeDirectory, owner, server, requests, headers, observed, connection: () => connection }
}

it.each(["missing", "wrong", "replayed"] as const)("never sends a bearer to a listener with a %s proof", async (proof) => {
  const fake = await peer({ proof })
  const result = await acquireLocalDaemon({ homeDirectory: fake.homeDirectory, environment: {}, mode: "start-or-attach", timeoutMs: 3_000 })
  expect(result).toMatchObject({ kind: "refused", reason: "owner-unverified" })
  expect(fake.headers).toHaveLength(1)
  expect(fake.headers[0]).not.toHaveProperty("authorization")
  expect(JSON.stringify(fake.headers)).not.toContain(fake.owner.authToken)
  expect(fake.requests).toEqual([])
})

it.each([
  ["identity", "owner-unverified"], ["auth", "owner-unverified"],
  ["protocol", "owner-incompatible"], ["record-changed", "owner-busy"],
] as const)("refuses a proved listener with a %s failure after hello", async (response, reason) => {
  const fake = await peer({ response })
  const result = await acquireLocalDaemon({ homeDirectory: fake.homeDirectory, environment: {}, mode: "start-or-attach", timeoutMs: 3_000 })
  expect(result).toMatchObject({ kind: "refused", reason })
  expect(fake.requests).toEqual([{ jsonrpc: "2.0", id: 1, method: "system.hello", params: {
    client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: fake.owner.authToken,
  } }])
})

it("bounds an unanswered hello and closes its socket without changing owner state", async () => {
  const fake = await peer({ response: "silent" })
  const observation = OperationDeadline.start(3_000)
  const result = acquireLocalDaemon({ homeDirectory: fake.homeDirectory, environment: {}, mode: "start-or-attach", timeoutMs: 2_000 })
  try {
    await beforeDeadline(fake.observed, observation)
    const socket = fake.connection()!
    const closed = once(socket, "close", { signal: observation.signal })
    expect(await beforeDeadline(result, observation)).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
    await closed
    expect(readLocalOwnerRecord(fake.homeDirectory)?.state).toBe("ready")
  } finally { observation.clear() }
})

it("bounds a listener that accepts TCP but never completes the WebSocket upgrade", async () => {
  const fake = await peer()
  const observation = OperationDeadline.start(3_000)
  let accepted: (() => void) | undefined
  const connected = new Promise<void>((resolve) => { accepted = resolve })
  let rawSocket: import("node:stream").Duplex | undefined
  fake.server.handleUpgrade = (request, socket) => {
    expect(request.headers).not.toHaveProperty("authorization")
    rawSocket = socket
    // An upgraded HTTP socket is paused. Consume FIN so this deliberately
    // silent peer can observe client teardown instead of retaining half-open I/O.
    socket.once("end", () => socket.destroy())
    socket.resume()
    accepted?.()
  }
  const result = acquireLocalDaemon({ homeDirectory: fake.homeDirectory, environment: {}, mode: "start-or-attach", timeoutMs: 2_000 })
  try {
    await beforeDeadline(connected, observation)
    const closed = once(rawSocket!, "close", { signal: observation.signal })
    expect(await beforeDeadline(result, observation)).toMatchObject({ kind: "refused", reason: "owner-unreachable" })
    await closed
    expect(fake.requests).toEqual([])
  } finally {
    rawSocket?.destroy()
    observation.clear()
  }
})

it("classifies clock expiry during final record verification as unreachable, not bad identity", async () => {
  const fake = await peer()
  let clock = 0
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  const read = ownerRecords.readLocalOwnerRecord
  let reads = 0
  vi.spyOn(ownerRecords, "readLocalOwnerRecord").mockImplementation((path) => {
    const record = read(path)
    if (++reads === 2) clock = 3_001
    return record
  })
  expect(await acquireLocalDaemon({ homeDirectory: fake.homeDirectory, environment: {}, mode: "attach-only", timeoutMs: 3_000 }))
    .toMatchObject({ kind: "refused", reason: "owner-unreachable" })
})
