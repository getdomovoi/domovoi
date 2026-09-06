import { fork, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { createServer, type Socket } from "node:net"

import { expect, it } from "vitest"
import { WebSocketServer } from "ws"

import { beforeDeadline, OperationDeadline } from "./operation-deadline.js"

const setupBudgetMs = 20_000
const teardownBudgetMs = 10_000

it("releases a stalled TLS socket and lets the refused CLI process exit naturally", async () => {
  const setup = OperationDeadline.start(setupBudgetMs)
  const sockets: Socket[] = []
  let receivedHello: (socket: Socket) => void = () => {}
  const clientHello = new Promise<Socket>((resolve) => { receivedHello = resolve })
  const listener = createServer((socket) => {
    sockets.push(socket)
    socket.once("data", (bytes: Buffer) => {
      // A real TLS handshake reached the kernel, not just an allocated socket.
      if (bytes[0] === 0x16) receivedHello(socket)
    })
    socket.resume()
  })
  let child: ChildProcess | undefined
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let diagnostics = ""
  try {
    listener.listen(0, "127.0.0.1")
    await once(listener, "listening", { signal: setup.signal })
    const { port } = listener.address() as { port: number }
    setup.throwIfExpired()
    child = fork(new URL("../test-fixtures/cli-rpc-lifecycle.mjs", import.meta.url), [String(port)], {
      execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    const record = (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192) }
    child.stdout?.on("data", record)
    child.stderr?.on("data", record)
    child.on("error", (error) => { diagnostics += error.message })
    exit = new Promise((resolve) => child!.once("exit", (code, signal) => resolve({ code, signal })))
    const result = new Promise((resolve) => child!.once("message", resolve))
    const peer = await beforeDeadline(clientHello, setup)
    const closed = new Promise<void>((resolve) => peer.once("close", () => resolve()))
    child.send("expire")
    expect(await beforeDeadline(result, setup), diagnostics).toMatchObject({
      kind: "refused", name: "CliDeadlineError",
      message: expect.stringContaining(`wss://127.0.0.1:${port}/rpc did not accept the connection`),
    })
    const teardown = OperationDeadline.start(teardownBudgetMs)
    try {
      // Observe both sides. Ending the fixture forcibly or merely unrefing its
      // native handle cannot substitute for actually disposing of the socket.
      await expect(beforeDeadline(closed, teardown), `TLS peer stayed open after CLI refusal. ${diagnostics}`).resolves.toBeUndefined()
      await expect(beforeDeadline(exit, teardown), diagnostics).resolves.toEqual({ code: 0, signal: null })
    } finally { teardown.clear() }
  } finally {
    setup.clear()
    const cleanup = OperationDeadline.start(teardownBudgetMs)
    try {
      // Only this test's child and accepted sockets. The failure path must not
      // strand the deliberately silent fixture or wait for Node's TLS timeout.
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      for (const socket of sockets) socket.destroy()
      await beforeDeadline(new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())), cleanup)
      if (exit) await beforeDeadline(exit, cleanup)
    } finally { cleanup.clear() }
  }
}, setupBudgetMs + 2 * teardownBudgetMs + 1_000)

it("lets an answered CLI process exit when the peer never acknowledges close", async () => {
  const setup = OperationDeadline.start(setupBudgetMs)
  const listener = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  listener.on("connection", (peer) => peer.on("message", (bytes) => {
    const request = JSON.parse(bytes.toString()) as { id: number; method: string }
    peer.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { code: "123456" } }))
    if (request.method === "device.issueCode") peer.pause()
  }))
  let child: ChildProcess | undefined
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  let diagnostics = ""
  try {
    await once(listener, "listening", { signal: setup.signal })
    const { port } = listener.address() as { port: number }
    setup.throwIfExpired()
    child = fork(new URL("../test-fixtures/cli-rpc-lifecycle.mjs", import.meta.url), [String(port), "success"], {
      execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    child.stdout?.on("data", (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192) })
    child.stderr?.on("data", (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-8_192) })
    child.on("error", (error) => { diagnostics += error.message })
    exit = new Promise((resolve) => child!.once("exit", (code, signal) => resolve({ code, signal })))
    expect(await once(child, "message", { signal: setup.signal }), diagnostics).toEqual([
      { kind: "answered", result: { code: "123456" } }, undefined,
    ])
    const teardown = OperationDeadline.start(teardownBudgetMs)
    try {
      await expect(beforeDeadline(exit, teardown), `Answered CLI still waits for its peer to close. ${diagnostics}`)
        .resolves.toEqual({ code: 0, signal: null })
    } finally { teardown.clear() }
  } finally {
    setup.clear()
    const cleanup = OperationDeadline.start(teardownBudgetMs)
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      for (const peer of listener.clients) peer.terminate()
      await beforeDeadline(new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())), cleanup)
      if (exit) await beforeDeadline(exit, cleanup)
    } finally { cleanup.clear() }
  }
}, setupBudgetMs + 2 * teardownBudgetMs + 1_000)
