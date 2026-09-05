import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { bootstrapDaemon } from "./bootstrap-daemon.mjs"

const execute = promisify(execFile)
const version = "1.0.0"
const archiveName = `getdomovoi-daemon-${version}.tgz`
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const testTimeout = 30_000

async function installer(options) {
  const module = await import("./bootstrap-install.mjs").catch(() => ({}))
  // Before this change bootstrap only downloaded bytes. Exercise that real
  // behavior as the red, not a mock installer that can never publish anything.
  return (module.installBootstrapDaemon ?? bootstrapDaemon)(options)
}

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "domovoi-runtime-test-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const into = join(root, "installed")
  const packageRoot = join(root, "source/package")
  await fs.mkdir(join(packageRoot, "runtime"), { recursive: true })
  await fs.mkdir(join(packageRoot, "dist"))
  const protocol = Buffer.from("bound protocol archive")
  const manifest = { name: "@getdomovoi/daemon", version, private: true, type: "module", dependencies: { "@getdomovoi/protocol": version, leaf: "^1.0.0" } }
  const lock = {
    name: manifest.name, version, lockfileVersion: 3, requires: true,
    packages: {
      "": manifest,
      "node_modules/@getdomovoi/protocol": { version, resolved: "file:runtime/protocol.tgz", integrity: integrity(protocol) },
      "node_modules/leaf": { version: "1.0.0", resolved: "https://registry.npmjs.org/leaf/-/leaf-1.0.0.tgz", integrity: integrity("leaf") },
    },
  }
  await fs.writeFile(join(packageRoot, "runtime/lock.json"), JSON.stringify(lock))
  await fs.writeFile(join(packageRoot, "runtime/package.json"), JSON.stringify(manifest))
  await fs.writeFile(join(packageRoot, "runtime/protocol.tgz"), protocol)
  await fs.writeFile(join(packageRoot, "package.json"), JSON.stringify({ ...manifest, devDependencies: { unshipped: "*" } }))
  await fs.writeFile(join(packageRoot, "dist/index.js"), 'console.log("DAEMON_FIXTURE_OK")\n')
  const archive = join(root, archiveName)
  const pack = async () => {
    await execute("tar", ["-czf", archive, "-C", join(root, "source"), "package"], { timeout: 10_000, killSignal: "SIGKILL" })
    return await fs.readFile(archive)
  }
  const bytes = await pack()
  const calls = []
  let installVersion = "1.0.0"
  let failInstall
  let afterInstall
  const run = async (command, args, options) => {
    calls.push({ command, args, deadline: options.deadline })
    options.deadline.check()
    if (args.includes("--version")) return { stdout: "12.0.2\n", stderr: "" }
    if (!args.includes("ci") && !args.includes("rebuild")) {
      return await execute(command, args, { cwd: options.cwd, signal: options.deadline.signal, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 })
    }
    if (failInstall) throw failInstall
    assert.ok(args.includes("--ignore-scripts"), "npm ci must not execute dependencies before graph verification")
    assert.deepEqual(JSON.parse(await fs.readFile(join(options.cwd, "package-lock.json"), "utf8")), lock)
    for (const [name, installedVersion] of [["@getdomovoi/protocol", version], ["leaf", installVersion]]) {
      const directory = join(options.cwd, "node_modules", name)
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(join(directory, "package.json"), JSON.stringify({ name, version: installedVersion }))
    }
    await fs.mkdir(join(options.cwd, "node_modules/.package-lock-holder"), { recursive: true })
    await fs.rmdir(join(options.cwd, "node_modules/.package-lock-holder"))
    await fs.writeFile(join(options.cwd, "node_modules/.package-lock.json"), JSON.stringify(lock))
    await afterInstall?.(options)
    return { stdout: "", stderr: "" }
  }
  const options = {
    version, destination: into, baseUrl: "https://releases.test", expectedSha256: sha256(bytes), run,
    download: async (url) => url.endsWith("SHA256SUMS") ? Buffer.from(`${sha256(bytes)}  ${archiveName}\n`) : bytes,
  }
  return { options, calls, root, packageRoot, lock, pack,
    setVersion: (value) => { installVersion = value },
    fail: (error) => { failInstall = error },
    afterInstall: (action) => { afterInstall = action },
  }
}

test("installs and verifies the frozen tree before publishing a runnable receipt", { timeout: testTimeout }, async (t) => {
  const { options, calls } = await fixture(t)
  const result = await installer(options)
  assert.equal(typeof result.runtimePath, "string", "a downloaded archive is not an installed daemon")
  const receipt = JSON.parse(await fs.readFile(join(options.destination, `v${version}`, "runtime.json"), "utf8"))
  assert.equal(receipt.sha256, options.expectedSha256)
  assert.equal(join(options.destination, `v${version}`, receipt.directory), result.runtimePath)
  assert.equal(calls.filter(({ args }) => args.includes("ci")).length, 1)
  assert.ok(calls.every(({ deadline }) => deadline === calls[0].deadline), "all phases spend one total deadline")
  assert.equal(await fs.readFile(join(result.runtimePath, "dist/index.js"), "utf8"), 'console.log("DAEMON_FIXTURE_OK")\n')
  if (process.platform !== "win32") assert.equal((await fs.stat(result.runtimePath)).mode & 0o077, 0)
})

for (const reason of ["npm failure", "dependency drift"]) {
  test(`does not publish a runtime after ${reason}`, { timeout: testTimeout }, async (t) => {
    const { options, fail, setVersion } = await fixture(t)
    if (reason === "npm failure") fail(new Error("npm fixture failed"))
    else setVersion("1.1.0")
    await assert.rejects(installer(options), reason === "npm failure" ? /npm fixture failed/ : /leaf.*1\.0\.0.*1\.1\.0/)
    await assert.rejects(fs.readFile(join(options.destination, `v${version}`, "runtime.json")), { code: "ENOENT" })
  })
}

test("spends download time from the same budget and refuses a late install result", { timeout: testTimeout }, async (t) => {
  const { options, calls, afterInstall } = await fixture(t)
  let now = 0
  t.mock.method(performance, "now", () => now)
  const download = options.download
  options.download = (...args) => { now += 100; return download(...args) }
  afterInstall(() => { now = 1_000 })
  await assert.rejects(installer({ ...options, timeoutMs: 1_000 }), /Bootstrap.*1000 ms/)
  assert.equal(calls.filter(({ args }) => args.includes("ci")).length, 1)
  await assert.rejects(fs.readFile(join(options.destination, `v${version}`, "runtime.json")), { code: "ENOENT" })
})

test("refuses a missing or old npm with the supported minimum", { timeout: testTimeout }, async (t) => {
  const { options } = await fixture(t)
  for (const outcome of ["9.9.9", undefined]) {
    await assert.rejects(installer({ ...options, run: async (_command, args) => {
      assert.ok(args.includes("--version"))
      if (!outcome) throw Object.assign(new Error("missing npm"), { code: "ENOENT" })
      return { stdout: `${outcome}\n`, stderr: "" }
    } }), /npm 10\.0\.0 or newer.*Node/i)
  }
})

test("binds protocol archive bytes before npm receives them", { timeout: testTimeout }, async (t) => {
  const { options, calls, packageRoot, pack } = await fixture(t)
  await fs.writeFile(join(packageRoot, "runtime/protocol.tgz"), "different protocol")
  const bytes = await pack()
  const digest = sha256(bytes)
  await assert.rejects(installer({ ...options, expectedSha256: digest,
    download: async (url) => url.endsWith("SHA256SUMS") ? `${digest}  ${archiveName}\n` : bytes,
  }), /protocol.*integrity/i)
  assert.equal(calls.filter(({ args }) => args.includes("ci")).length, 0)
})
