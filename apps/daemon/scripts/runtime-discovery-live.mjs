// Opt-in proof with installed, authenticated providers. Sends no model prompt.
// Run after building protocol and daemon: node apps/daemon/scripts/runtime-discovery-live.mjs
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { createProductionDaemon } from "../dist/public.js"

const require = createRequire(new URL("../package.json", import.meta.url))
const { WebSocket } = require("ws")
const { protocolVersion, rpcMethods } = await import("@getdomovoi/protocol")
const exec = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "domovoi-runtime-live-"))
const handles = []
const sockets = []
const report = { protocolVersion, machines: [], restarted: false }
const logPath = process.argv[2]

async function connect(url, token, client = "phone") {
  const socket = new WebSocket(url, { handshakeTimeout: 5_000 })
  sockets.push(socket)
  await once(socket, "open")
  let nextId = 0
  async function call(method, params) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.off("message", receive); socket.off("close", closed) }
      const closed = () => { cleanup(); reject(new Error(`Socket closed during ${method}`)) }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Live proof deadline: ${method}`)) }, 45_000)
      const receive = (bytes) => {
        const response = JSON.parse(bytes.toString())
        if (response.id !== id) return
        cleanup()
        // Never repeat raw provider output or credentials in a proof report.
        if (response.error) reject(new Error(`Live RPC ${method} failed with code ${response.error.code}`))
        else resolve(rpcMethods[method].result.parse(response.result))
      }
      socket.on("message", receive)
      socket.once("close", closed)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
  const snapshot = await call("system.hello", { client, clientVersion: "0.0.1", protocolVersion, authToken: token })
  return { call, snapshot, socket }
}

async function start(homeDirectory, label) {
  const handle = await createProductionDaemon({ homeDirectory, machineLabel: label,
    environment: { DOMOVOI_HOST: "127.0.0.1", DOMOVOI_PORT: "0" }, errorSink: () => {},
  })
  handles.push(handle)
  const address = await handle.start()
  return { handle, address }
}

try {
  for (const index of [1, 2]) {
    const homeDirectory = join(root, `machine-${index}`)
    const repository = join(root, `project-${index}`)
    await mkdir(repository)
    const git = (args) => exec("git", args, { cwd: repository, timeout: 10_000 })
    await git(["init", "-b", "main"])
    await git(["config", "user.name", "Domovoi Test"])
    await git(["config", "user.email", "test@example.invalid"])
    await writeFile(join(repository, "README.md"), "Runtime discovery proof\n")
    await git(["add", "README.md"])
    await git(["commit", "-m", "test: initialize runtime proof"])
    const { handle, address } = await start(homeDirectory, `runtime-proof-${index}`)
    const provisioner = await connect(address.url, handle.authToken)
    const pairing = await provisioner.call("device.pair", { label: "runtime proof phone", client: "phone" })
    provisioner.socket.terminate()
    const phone = await connect(address.url, pairing.token)
    const snapshot = await phone.call("provider.refresh", { client: "phone" })
    const machine = { machineId: snapshot.machine.id, providers: snapshot.machine.providers, discoveries: [] }
    report.machines.push(machine)
    let chosen
    for (const provider of snapshot.machine.providers) {
      const began = performance.now()
      const discovery = await phone.call("runtime.discover", { provider: provider.id, client: "phone" })
      assert.equal(discovery.machineId, snapshot.machine.id)
      const elapsedMs = Math.round(performance.now() - began)
      assert(elapsedMs < 15_000, "Discovery exceeded its budget plus local transport margin")
      machine.discoveries.push({ ...discovery, elapsedMs })
      if (discovery.status === "ready" && (!chosen || provider.id === "codex")) chosen = discovery
      console.log(JSON.stringify({ machine: index, provider: provider.id, status: discovery.status,
        ...(discovery.status === "ready" ? { models: discovery.models.length, defaultRuntime: discovery.defaultRuntime }
          : { reason: discovery.reason }), elapsedMs }))
    }
    assert(chosen, "No installed authenticated provider returned a usable runtime")
    await phone.call("project.open", { path: repository, client: "phone" })
    const created = await phone.call("session.create", { title: "Runtime discovery proof", client: "phone", runtime: chosen.defaultRuntime })
    const session = created.sessions.find(({ id }) => id === created.activeSessionId)
    assert.deepEqual(session.runtime, chosen.defaultRuntime)
    assert(session.providerThreadId, "A real provider thread must have started")
    const worktree = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: session.workspacePath, timeout: 10_000 })
    assert.equal(worktree.stdout.trim(), session.workspacePath)
    machine.created = { sessionId: session.id, runtime: session.runtime, providerThreadStarted: true, gitWorktreeVerified: true }
    phone.socket.terminate()
    await handle.stop()
    const restarted = await start(homeDirectory, `runtime-proof-${index}`)
    const returnedPhone = await connect(restarted.address.url, pairing.token)
    assert.equal(returnedPhone.snapshot.machine.id, machine.machineId)
    assert.deepEqual(returnedPhone.snapshot.sessions.find(({ id }) => id === session.id)?.runtime, chosen.defaultRuntime)
    returnedPhone.socket.terminate()
    await restarted.handle.stop()
  }
  assert.notEqual(report.machines[0].machineId, report.machines[1].machineId)
  report.restarted = true
  if (logPath) await writeFile(logPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ passed: true, machines: report.machines.length, restarted: true, providerPromptsSent: 0 }))
} finally {
  for (const socket of sockets) socket.terminate()
  const stops = await Promise.allSettled(handles.map((handle) => handle.stop()))
  const failed = stops.filter((result) => result.status === "rejected")
  if (failed.length > 0) throw new Error("Live proof daemon cleanup failed")
  await rm(root, { recursive: true, force: true })
}
