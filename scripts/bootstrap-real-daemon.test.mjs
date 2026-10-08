import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
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

// The npm that ships with this Node: beside node.exe on Windows, under
// ../lib on the other release archives, and through Homebrew's sibling link.
async function bundledNpmCli() {
  const base = dirname(process.execPath)
  for (const candidate of [join(base, "node_modules/npm/bin/npm-cli.js"), join(base, "../lib/node_modules/npm/bin/npm-cli.js")]) {
    if ((await lstat(candidate).catch(() => undefined))?.isFile()) return candidate
  }
  const linked = await realpath(join(base, "npm")).catch(() => undefined)
  if (linked !== undefined && basename(linked) === "npm-cli.js") return linked
  throw new Error(`npm-cli.js was not found beside ${process.execPath}`)
}

// Node 22 announces node:sqlite on stderr, for domovoid as well (ruling Q32 A).
const withoutSqliteNotice = (stderr) => stderr.replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature[^\n]*\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?/gmu, "")

// Ruling Q3 B: `domovoi daemon` runs the daemon package's own installer. Run
// from packages npm installed from the packed archives, it must register the
// daemon's worker entry, never the CLI's, which would start a CLI where the
// service manager expects a daemon. The OS boundary is the manager shim, so no
// real service is installed and the operator's profile is never read.
test("domovoi daemon from the installed packages registers the daemon's worker entry, not the CLI's", { timeout: 900_000 }, async (t) => {
  // schtasks refuses a command over 261 characters, and the installer
  // refuses it first. The runner's own temporary directory, D:\a\_temp, is
  // shorter than the user's, so the node, entry and configuration paths fit.
  const scratch = process.platform === "win32" && process.env.RUNNER_TEMP ? process.env.RUNNER_TEMP : tmpdir()
  const root = await realpath(await mkdtemp(join(scratch, "domovoi-cli-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archives = []
  for (const selector of ["@getdomovoi/protocol", "@getdomovoi/credential-store", "@getdomovoi/daemon", "@getdomovoi/cli"]) {
    const destination = join(root, "pack", selector.split("/")[1])
    await mkdir(destination, { recursive: true })
    archives.push(await packPackage(selector, destination))
  }
  const prefix = join(root, "i")
  await mkdir(prefix)
  await writeFile(join(prefix, "package.json"), "{\"private\":true}\n")
  // The workspace packages come from their archives; third-party packages
  // from the registry. Lifecycle scripts stay off: registering a service
  // loads no native module.
  const cache = join(root, ".npm-cache")
  await execute(process.execPath, [await bundledNpmCli(), "install", "--global=false", "--prefix", prefix, "--cache", cache,
    "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...archives],
  { cwd: prefix, encoding: "utf8", timeout: 600_000, killSignal: "SIGKILL", env: { ...process.env, npm_config_cache: cache }, maxBuffer: 16 * 1024 * 1024 })

  const cliEntry = await realpath(join(prefix, "node_modules/@getdomovoi/cli/dist/index.js"))
  const workerEntry = await realpath(join(prefix, "node_modules/@getdomovoi/daemon/dist/index.js"))
  const home = join(root, "home")
  await mkdir(home)
  const environment = {
    ...isolatedEnvironment(home),
    DOMOVOI_TEST_SERVICE_HOME: home, DOMOVOI_TEST_MANAGER_LOG: join(home, "manager.jsonl"),
    // The installed bin finds node through PATH; this one is the test's.
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    NODE_OPTIONS: `--import=${new URL("../apps/cli/test-fixtures/service-manager.mjs", import.meta.url).href}`,
  }
  // The command a person runs: npm's bin link, or its .cmd shim on Windows,
  // which runs the same entry through node.
  const domovoi = (verb) => process.platform === "win32"
    ? execute(process.execPath, [cliEntry, "daemon", verb], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", env: environment })
    : execute(join(prefix, "node_modules/.bin/domovoi"), ["daemon", verb], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", env: environment })

  const installed = await domovoi("install")
  assert.equal(withoutSqliteNotice(installed.stderr), "")
  assert.match(installed.stdout, /^Installed the Domovoi daemon service /mu)
  // What the manager was told to run: the unit, the launch agent, or the
  // command Task Scheduler's /create received.
  const launch = process.platform === "win32"
    ? (() => {
      const create = readFileSync(join(home, "manager.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .findLast(({ command, args }) => command.endsWith("\\System32\\schtasks.exe") && args[0] === "/create")
      return create.args[create.args.indexOf("/tr") + 1]
    })()
    : await readFile(process.platform === "darwin"
      ? join(home, "Library/LaunchAgents/sh.domovoi.domovoid.plist")
      : join(home, ".config/systemd/user/domovoid.service"), "utf8")
  assert.ok(launch.includes(workerEntry), `the service must run the daemon's worker entry ${workerEntry}: ${launch}`)
  assert.ok(!launch.includes(dirname(cliEntry)), `the service must not run the CLI: ${launch}`)
  t.diagnostic(`registered ${workerEntry}`)

  // Task Scheduler's status reads supervisor evidence the shim does not
  // produce; elsewhere the exit meanings of domovoid service hold.
  if (process.platform !== "win32") {
    const status = await domovoi("status")
    assert.match(status.stdout, /^installed, /u)
    const removed = await domovoi("remove")
    assert.match(removed.stdout, /^Removed the Domovoi daemon service /u)
    await assert.rejects(domovoi("status"), (error) => error.code === 1 && /^not installed, not running: /u.test(error.stdout))
  }
})
