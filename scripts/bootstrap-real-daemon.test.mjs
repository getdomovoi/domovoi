import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { installBootstrapDaemon } from "./bootstrap-install.mjs"
import { inspectArchive, packPackage } from "./pack-package.mjs"

const execute = promisify(execFile)

// The published archive is the only input. Nothing below reads this repository's
// node_modules, so an installation that only unpacked bytes cannot borrow a
// dependency graph from the machine that built it.
const clientScript = `import { readFileSync } from "node:fs"
import { protocolVersion, systemHelloResultSchema } from "@getdomovoi/protocol"
import { WebSocket } from "ws"

const endpoint = JSON.parse(readFileSync(process.env.BOOTSTRAP_TEST_ENDPOINT, "utf8"))
const socket = new WebSocket(\`ws://\${endpoint.host}:\${endpoint.port}/rpc\`, {
  headers: { authorization: \`Bearer \${endpoint.token}\` },
})
try {
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
  socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.hello",
    params: { client: "cli", clientVersion: "0.0.1", protocolVersion } }))
  const message = await new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString())))
    socket.once("error", reject)
    socket.once("close", () => reject(new Error("The daemon closed the connection before answering")))
  })
  if (message.error) throw new Error(message.error.message)
  const snapshot = systemHelloResultSchema.parse(message.result)
  process.stdout.write(JSON.stringify({ protocolVersion, platform: snapshot.machine.platform,
    version: snapshot.machine.version, sessions: snapshot.sessions.length }))
} finally { socket.close() }
`

const graphScript = `import { protocolVersion } from "@getdomovoi/protocol"

const pty = await import("node-pty")
const keyring = await import("@napi-rs/keyring")
process.stdout.write(JSON.stringify({ protocolVersion, pty: typeof pty.spawn, keyring: typeof keyring.Entry }))
`

function isolatedEnvironment(home) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith("DOMOVOI_")) delete environment[key]
  return { ...environment, HOME: home, USERPROFILE: home }
}

async function firstLine(child, pattern, timeoutMs) {
  let text = ""
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The installed daemon printed no ${pattern} within ${timeoutMs} ms: ${JSON.stringify(text)}`)), timeoutMs)
    const settle = (finish) => { clearTimeout(timer); child.stdout.off("data", read); child.off("exit", exited); finish() }
    const read = (chunk) => {
      text += chunk
      const match = pattern.exec(text)
      if (match) settle(() => resolve(match))
    }
    const exited = (code, signal) => settle(() => reject(new Error(`The installed daemon exited early with ${code} ${signal}: ${JSON.stringify(text)}`)))
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", read)
    child.once("exit", exited)
  })
}

test("the packed daemon bootstraps into an installation that runs and serves", { timeout: 900_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "domovoi-real-bootstrap-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packDirectory = join(root, "pack")
  await mkdir(packDirectory)
  const archive = await packPackage("@getdomovoi/daemon", packDirectory)
  const bytes = await readFile(archive)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const { manifest } = await inspectArchive(archive)
  const version = manifest.version

  // The real release archive, through the real entry point, into a clean
  // directory. Only the transport is a fixture; npm resolves and builds the
  // reviewed graph itself from the packed lock.
  const result = await installBootstrapDaemon({
    version, destination: join(root, "release"), baseUrl: "https://release.invalid", expectedSha256: sha256,
    timeoutMs: 600_000,
    download: async (url) => url.endsWith("SHA256SUMS") ? `${sha256}  getdomovoi-daemon-${version}.tgz\n` : bytes,
  })
  assert.equal(typeof result.runtimePath, "string", "bootstrap must install a runtime, not only save the archive")
  const entry = join(result.runtimePath, "dist/index.js")
  const options = { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", env: isolatedEnvironment(join(root, "probe-home")) }

  const reported = await execute(process.execPath, [entry, "--version"], options)
  assert.equal(reported.stdout.trim(), version, "the installed command must report the packed version")
  const help = await execute(process.execPath, [entry, "--help"], options)
  assert.match(help.stdout, /^Usage: domovoid/mu)

  // Native modules are the failure that unpacked bytes hide. Importing them
  // from the installed tree proves the rebuild produced loadable binaries.
  const graph = await execute(process.execPath, ["--input-type=module", "-e", graphScript],
    { ...options, cwd: result.runtimePath })
  const loaded = JSON.parse(graph.stdout)
  assert.match(loaded.protocolVersion, /^\d+\.\d+\.\d+$/u, "the same-release protocol must import from the installed tree")
  assert.equal(loaded.pty, "function", "node-pty must load its rebuilt native binding")
  assert.equal(loaded.keyring, "function", "the keyring platform package must load")

  const home = join(root, "home")
  await mkdir(home)
  const daemon = spawn(process.execPath, [entry], {
    env: { ...isolatedEnvironment(home), DOMOVOI_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  })
  let stopped = false
  t.after(() => { if (!stopped) daemon.kill("SIGKILL") })
  let stderr = ""
  daemon.stderr.setEncoding("utf8")
  daemon.stderr.on("data", (chunk) => { stderr += chunk })
  const listening = await firstLine(daemon, /domovoid listening on (ws:\/\/127\.0\.0\.1:\d+\/rpc)\n/u, 120_000)
  t.diagnostic(`installed daemon listening on ${listening[1]}`)

  const endpointPath = join(home, ".domovoi/endpoint.json")
  const credential = join(home, ".domovoi/daemon.token")
  assert.match(await readFile(credential, "utf8"), /\S/u, "the daemon must write its credential inside the isolated home")

  // A real client, built from the installed tree's own protocol and ws copies,
  // completes the handshake the shipped CLI performs.
  const hello = await execute(process.execPath, ["--input-type=module", "-e", clientScript], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", cwd: result.runtimePath,
    env: { ...isolatedEnvironment(home), BOOTSTRAP_TEST_ENDPOINT: endpointPath },
  })
  const answer = JSON.parse(hello.stdout)
  assert.equal(answer.platform, process.platform)
  assert.equal(answer.version, version, "the running daemon must report the installed version")
  assert.equal(answer.sessions, 0, "an isolated home starts with no sessions")

  const exit = new Promise((resolve) => daemon.once("exit", (code, signal) => resolve({ code, signal })))
  daemon.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM")
  const outcome = await exit
  stopped = true
  if (process.platform === "win32") {
    t.diagnostic("Windows has no graceful termination signal, so only the exit is asserted")
  } else {
    assert.equal(outcome.code, 0, `SIGTERM must run the shutdown path: ${JSON.stringify(outcome)} ${stderr}`)
    await assert.rejects(readFile(endpointPath), { code: "ENOENT" }, "shutdown must withdraw the endpoint file")
  }
  t.diagnostic("Real packed daemon: installed from the archive, ran --version and --help, loaded native modules, served system.hello, stopped.")
})
