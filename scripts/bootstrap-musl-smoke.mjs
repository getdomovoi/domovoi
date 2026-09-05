// Runs only inside the isolated Alpine container created by test-bootstrap-musl.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"
import { installBootstrapDaemon } from "./bootstrap-install.mjs"

assert.equal(process.platform, "linux")
assert.equal(process.arch, "x64")
assert.equal(process.report.getReport().header.glibcVersionRuntime, undefined, "this proof needs musl Node, not glibc compatibility")
const inputs = bootstrapDeadline(10_000, "Alpine smoke inputs exceeded 10000 ms")
let input
let archive
let root
try {
  input = JSON.parse(await inputs.run(() => readFile(new URL("./input.json", import.meta.url), "utf8")))
  archive = await inputs.run(() => readFile(new URL("./daemon.tgz", import.meta.url)))
  root = await inputs.run(() => mkdtemp(join(tmpdir(), "domovoi-musl-")))
} finally { inputs.clear() }
const result = await installBootstrapDaemon({
  version: input.version, expectedSha256: input.sha256, destination: join(root, "installed"),
  baseUrl: "https://musl-fixture.test", timeoutMs: 300_000,
  download: async (url) => url.endsWith("SHA256SUMS")
    ? `${input.sha256}  getdomovoi-daemon-${input.version}.tgz\n` : archive,
})
const require = createRequire(join(result.runtimePath, "package.json"))
const pty = require("node-pty")
const native = require(join(dirname(require.resolve("node-pty/package.json")), "lib/utils.js")).loadNativeModule("pty")
assert.equal(native.dir, "../build/Release", "musl must use its source build, not the platform-only prebuild")

const deadline = bootstrapDeadline(20_000, "Alpine native and daemon smoke exceeded 20000 ms")
let terminal
let daemon
let socket
try {
  const marker = "DOMOVOI_MUSL_PTY_OK"
  let output = ""
  await deadline.run(() => new Promise((resolve, reject) => {
    terminal = pty.spawn("/bin/sh", ["-c", `printf ${marker}`], { cols: 80, rows: 24, env: process.env })
    terminal.onData((chunk) => { output += chunk })
    terminal.onExit(({ exitCode }) => {
      if (exitCode === 0 && output.includes(marker)) resolve()
      else reject(new Error(`Alpine PTY failed: ${exitCode}, ${JSON.stringify(output)}`))
    })
  }))
  console.log(marker)
  const { createProductionDaemon } = await deadline.run(() => import(pathToFileURL(join(result.runtimePath, "dist/public.js"))))
  // No host profile or secrets enter the container. This is the real public
  // factory with its production stores, not a fixture server constructor.
  daemon = await deadline.run(() => createProductionDaemon({ homeDirectory: join(root, "profile"),
    environment: { DOMOVOI_AUTH_TOKEN: randomBytes(32).toString("base64url") } }))
  const endpoint = await deadline.run(() => daemon.start())
  const { protocolVersion } = require("@getdomovoi/protocol")
  const WebSocket = require("ws")
  await deadline.run(() => new Promise((resolve, reject) => {
    socket = new WebSocket(endpoint.url, { headers: { authorization: `Bearer ${daemon.authToken}` } })
    socket.on("error", reject)
    socket.on("close", () => reject(new Error("Alpine daemon closed before hello completed")))
    socket.on("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: "hello", method: "system.hello",
      params: { client: "cli", clientId: "musl-smoke", clientVersion: input.version, protocolVersion } })))
    socket.on("message", (bytes) => {
      const reply = JSON.parse(String(bytes))
      if (reply.id !== "hello") return
      if (reply.error) reject(new Error(JSON.stringify(reply.error)))
      else if (reply.result) resolve()
    })
  }))
  console.log("DOMOVOI_MUSL_DAEMON_HELLO_OK")
} finally {
  try {
    socket?.terminate()
    terminal?.kill()
    if (daemon) await deadline.run(() => daemon.stop())
  } finally { deadline.clear() }
}

// A reused receipt must remain usable without compiling again.
const reused = await installBootstrapDaemon({
  version: input.version, expectedSha256: input.sha256, destination: join(root, "installed"),
  baseUrl: "https://musl-fixture.test", timeoutMs: 30_000,
  download: async (url) => url.endsWith("SHA256SUMS")
    ? `${input.sha256}  getdomovoi-daemon-${input.version}.tgz\n` : archive,
})
assert.equal(reused.runtimePath, result.runtimePath)
console.log("DOMOVOI_MUSL_BOOTSTRAP_OK")
