import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { protocolVersion, workspaceSnapshotSchema } from "@getdomovoi/protocol"
import { expect, it } from "vitest"
import { WebSocket } from "ws"

import { OperationDeadline } from "./operation-deadline.js"
import { withinServiceDeadline } from "./service/deadline.js"
import { waitForDaemon } from "./test-wait-for.js"

const budget = process.platform === "win32" ? 40_000 : 20_000
const probeBudget = process.platform === "win32" ? 5_000 : 1_500
const cleanupBudget = 10_000
const beforeDeadline = <T>(operation: Promise<T>, deadline: OperationDeadline) =>
  withinServiceDeadline(deadline, () => operation)

it("answers unrelated RPC while a native keyring constructor is blocked", async () => {
  const deadline = OperationDeadline.start(budget)
  const home = await beforeDeadline(mkdtemp(join(tmpdir(), "domovoi-keyring-loop-")), deadline)
  let child: ReturnType<typeof spawn> | undefined
  let exited: Promise<unknown> | undefined
  let socket: WebSocket | undefined
  try {
    deadline.throwIfExpired()
    child = spawn(process.execPath, [
      "--import", new URL("../test-fixtures/blocked-keyring.mjs", import.meta.url).href,
      "--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL("../test-fixtures/keyring-daemon.mjs", import.meta.url)), home,
    ], {
      env: { ...process.env, DOMOVOI_TEST_KEYRING_DIRECTORY: home, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"], signal: deadline.signal, killSignal: "SIGKILL",
    })
    exited = once(child, "exit")
    void exited.catch(() => {})
    let stdout = ""
    let stderr = ""
    child.stdout!.on("data", (bytes: Buffer) => { stdout += bytes.toString() })
    child.stderr!.on("data", (bytes: Buffer) => { stderr += bytes.toString() })
    await beforeDeadline(waitForDaemon(() => {
      expect(child!.exitCode, stderr).toBeNull()
      expect(stdout).toContain('"url":')
    }), deadline)
    const { url } = JSON.parse(stdout.trim()) as { url: string }
    deadline.throwIfExpired()
    socket = new WebSocket(url, { handshakeTimeout: Math.ceil(deadline.remainingMs()) })
    await once(socket, "open", { signal: deadline.signal })
    let id = 0
    const rpc = (method: string, params: object, active = deadline) => {
      active.throwIfExpired()
      const requestId = ++id
      let receive: (bytes: WebSocket.RawData) => void
      let closed: () => void
      const response = new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
        closed = () => reject(new Error(`Socket closed during ${method}`))
        receive = (bytes) => {
          const value = JSON.parse(bytes.toString()) as { id?: number; result?: unknown; error?: unknown }
          if (value.id === requestId) resolve(value)
        }
        socket!.on("message", receive)
        socket!.once("close", closed)
        socket!.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      })
      return beforeDeadline(response, active).finally(() => {
        socket!.off("message", receive)
        socket!.off("close", closed)
      })
    }
    expect((await rpc("system.hello", {
      client: "cli", clientVersion: "keyring-probe", protocolVersion, authToken: "k".repeat(43),
    })).error).toBeUndefined()
    await beforeDeadline(writeFile(join(home, "block"), "hold"), deadline)
    const listing = rpc("fleet.list", {})
    void listing.catch(() => {})
    await beforeDeadline(waitForDaemon(async () => { await stat(join(home, "entered")) }), deadline)
    const thread = JSON.parse(await beforeDeadline(readFile(join(home, "entered"), "utf8"), deadline)) as { isMainThread: boolean }
    const probe = deadline.limit(probeBudget)
    try {
      const reply = await rpc("workspace.get", {}, probe).catch((cause: unknown) => {
        throw new Error(`workspace.get failed while the native constructor was held, isMainThread=${thread.isMainThread}`, { cause })
      })
      expect(reply.error).toBeUndefined()
      expect(workspaceSnapshotSchema.parse(reply.result).machine.id).toMatch(/^machine-/)
      expect(thread).toEqual({ isMainThread: false })
      // Source development must execute today's source, not a worker left
      // behind by an earlier build. No worker-constructor mock proves this.
      expect(await readFile(join(home, "native-stack"), "utf8")).toMatch(/machine-keyring-worker\.ts[?:]/)
    } finally { probe.clear() }
    await beforeDeadline(rm(join(home, "block")), deadline)
    expect((await listing).error).toBeUndefined()
  } finally {
    socket?.terminate()
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    deadline.clear()
    const cleanup = OperationDeadline.start(cleanupBudget)
    try {
      if (exited) await beforeDeadline(exited, cleanup)
      await beforeDeadline(rm(home, { recursive: true, force: true }), cleanup)
    } finally { cleanup.clear() }
  }
}, budget + cleanupBudget + 1_000)
