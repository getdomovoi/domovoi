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
  let afterBuild
  const run = async (command, args, options) => {
    calls.push({ command, args, deadline: options.deadline })
    options.deadline.check()
    if (args.includes("--version")) return { stdout: "12.0.2\n", stderr: "" }
    if (!args.includes("ci") && !args.includes("rebuild")) {
      return await execute(command, args, { cwd: options.cwd, signal: options.deadline.signal, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 })
    }
    if (failInstall) throw failInstall
    if (args.includes("rebuild")) {
      await afterBuild?.(options)
      return { stdout: "rebuild reported success", stderr: "" }
    }
    assert.ok(args.includes("--global=false"))
    assert.equal(args[args.indexOf("--prefix") + 1], options.cwd)
    assert.equal(args[args.indexOf("--cache") + 1], join(options.cwd, "../.npm-cache"))
    assert.ok(args.includes("--ignore-scripts"), "npm ci must not execute dependencies before graph verification")
    assert.deepEqual(JSON.parse(await fs.readFile(join(options.cwd, "package-lock.json"), "utf8")), lock)
    for (const [name, installedVersion] of [["@getdomovoi/protocol", version], ["leaf", installVersion]]) {
      const directory = join(options.cwd, "node_modules", name)
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(join(directory, "package.json"), JSON.stringify({ name, version: installedVersion }))
    }
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
    afterBuild: (action) => { afterBuild = action },
  }
}

async function nativeFixture(t, source = "module.exports = {}\n", bindingSource = "module.exports = {}\n") {
  const setup = await fixture(t)
  const { lock, packageRoot, options, afterInstall, pack } = setup
  lock.packages[""].dependencies["node-pty"] = "1.0.0"
  lock.packages[""].allowScripts = { "node-pty@1.0.0": true }
  lock.packages["node_modules/node-pty"] = {
    version: "1.0.0", resolved: "https://registry.npmjs.org/node-pty/-/node-pty-1.0.0.tgz", integrity: integrity("node-pty"), hasInstallScript: true,
  }
  await fs.writeFile(join(packageRoot, "runtime/lock.json"), JSON.stringify(lock))
  await fs.writeFile(join(packageRoot, "runtime/package.json"), JSON.stringify(lock.packages[""]))
  const bytes = await pack()
  options.expectedSha256 = sha256(bytes)
  options.download = async (url) => url.endsWith("SHA256SUMS") ? `${sha256(bytes)}  ${archiveName}\n` : bytes
  afterInstall(async ({ cwd }) => {
    const native = join(cwd, "node_modules/node-pty")
    await fs.mkdir(native, { recursive: true })
    await fs.writeFile(join(native, "package.json"), JSON.stringify({ name: "node-pty", version: "1.0.0", main: "index.js" }))
    await fs.writeFile(join(native, "index.js"), source)
    await fs.mkdir(join(native, "lib"))
    await fs.writeFile(join(native, "lib/utils.js"), 'exports.loadNativeModule = () => ({ module: require("../binding.js") })\n')
    await fs.writeFile(join(native, "binding.js"), bindingSource)
  })
  return setup
}

test("musl native builds cannot inherit an instruction to keep a glibc prebuild", async () => {
  const { nodePtyBuildEnvironment } = await import("./bootstrap-install.mjs")
  assert.equal(typeof nodePtyBuildEnvironment, "function")
  const original = { NPM_CONFIG_BUILD_FROM_SOURCE: "false", npm_config_build_from_source: "false", UNRELATED: "kept" }
  for (const libc of ["musl", undefined]) {
    const env = nodePtyBuildEnvironment({ os: "linux", cpu: "x64", libc }, original)
    assert.equal(env.npm_config_build_from_source, "true")
    assert.equal(Object.hasOwn(env, "NPM_CONFIG_BUILD_FROM_SOURCE"), false)
    assert.equal(env.UNRELATED, "kept")
  }
  for (const os of ["darwin", "win32", "linux"]) {
    assert.deepEqual(nodePtyBuildEnvironment({ os, cpu: "x64", libc: "glibc" }, original), original)
  }
  assert.equal(original.npm_config_build_from_source, "false", "native build policy must not mutate the caller environment")
})

test("does not publish when npm succeeds but the native terminal module cannot load", { timeout: testTimeout }, async (t) => {
  const { options, calls } = await nativeFixture(t, 'throw new Error("glibc prebuild on musl")\n')
  await assert.rejects(installer(options), /native terminal.*load/i)
  assert.equal(calls.filter(({ args }) => args.includes("rebuild")).length, 1)
  await assert.rejects(fs.readFile(join(options.destination, `v${version}`, "runtime.json")), { code: "ENOENT" })
})

test("rejects an old unusable native runtime receipt without replacing it", { timeout: testTimeout }, async (t) => {
  const { options, calls } = await nativeFixture(t)
  const result = await installer(options)
  const receiptPath = join(options.destination, `v${version}`, "runtime.json")
  const receipt = await fs.readFile(receiptPath)
  await fs.writeFile(join(result.runtimePath, "node_modules/node-pty/index.js"), 'throw new Error("wrong libc")\n')
  await assert.rejects(installer(options), /native terminal.*load/i)
  assert.deepEqual(await fs.readFile(receiptPath), receipt)
  assert.equal(calls.filter(({ args }) => args.includes("ci")).length, 1)
  assert.ok(calls.every(({ deadline }) => deadline === calls.find(({ args }) => args.includes("ci")).deadline ||
    deadline === calls.at(-1).deadline), "native probes stay within their install or reuse deadline")
})

test("a failed native build cannot publish a runnable receipt", { timeout: testTimeout }, async (t) => {
  const { options, afterBuild } = await nativeFixture(t)
  afterBuild(() => { throw new Error("node-gyp: missing C++ compiler") })
  await assert.rejects(installer(options), /node-gyp: missing C\+\+ compiler/)
  await assert.rejects(fs.readFile(join(options.destination, `v${version}`, "runtime.json")), { code: "ENOENT" })
})

test("does not publish when the entry loads but the lazy native binding is broken", { timeout: testTimeout }, async (t) => {
  const { options } = await nativeFixture(t, "module.exports = {}\n", 'throw new Error("ConPTY native binding cannot load")\n')
  await assert.rejects(installer(options), /native terminal.*load/i)
  await assert.rejects(fs.readFile(join(options.destination, `v${version}`, "runtime.json")), { code: "ENOENT" })
})

test("native load verification cannot extend the installation deadline", { timeout: testTimeout }, async (t) => {
  const { options, calls } = await nativeFixture(t)
  let now = 0
  t.mock.method(performance, "now", () => now)
  const run = options.run
  options.run = async (command, args, context) => {
    const result = await run(command, args, context)
    if (args.includes("--eval")) now = 1_000
    return result
  }
  await assert.rejects(installer({ ...options, timeoutMs: 1_000 }), /Bootstrap.*1000 ms/)
  assert.equal(calls.filter(({ args }) => args.includes("--eval")).length, 1)
  assert.ok(calls.every(({ deadline }) => deadline === calls[0].deadline))
  await assert.rejects(fs.readFile(join(options.destination, `v${version}`, "runtime.json")), { code: "ENOENT" })
})

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

for (const unsafe of ["parent", "duplicate", "symlink", "special"]) {
  test(`refuses ${unsafe} archive entries before extracting or installing`, { timeout: testTimeout }, async (t) => {
    const { options, calls } = await fixture(t)
    const run = options.run
    const seen = []
    options.run = async (command, args, context) => {
      seen.push(args)
      if (args.includes("-tzf")) return { stdout: unsafe === "parent" ? "package/../outside\n"
        : unsafe === "duplicate" ? "package/package.json\npackage/package.json\n" : "package/package.json\n", stderr: "" }
      if (args.includes("-tvzf")) return { stdout: `${unsafe === "symlink" ? "l" : "p"}rw------- user package/package.json\n`, stderr: "" }
      return await run(command, args, context)
    }
    await assert.rejects(installer(options), /Unsafe or duplicate|link or special/)
    assert.equal(seen.some((args) => args.includes("-xzf")), false)
    assert.equal(calls.some(({ args }) => args.includes("ci")), false)
  })
}

test("rejects an expanded build permission before running npm", { timeout: testTimeout }, async (t) => {
  const { options, calls, lock, packageRoot, pack } = await fixture(t)
  lock.packages[""].allowScripts = { leaf: true }
  await fs.writeFile(join(packageRoot, "runtime/lock.json"), JSON.stringify(lock))
  await fs.writeFile(join(packageRoot, "runtime/package.json"), JSON.stringify(lock.packages[""]))
  const bytes = await pack()
  const digest = sha256(bytes)
  await assert.rejects(installer({ ...options, expectedSha256: digest,
    download: async (url) => url.endsWith("SHA256SUMS") ? `${digest}  ${archiveName}\n` : bytes,
  }), /unreviewed native build permission/)
  assert.equal(calls.some(({ args }) => args.includes("ci")), false)
})

test("reuses a verified installation without rerunning npm and releases its deadline", { timeout: testTimeout }, async (t) => {
  const { options, calls } = await fixture(t)
  const first = await installer(options)
  const timers = new Set()
  const schedule = globalThis.setTimeout
  const clear = globalThis.clearTimeout
  t.mock.method(globalThis, "setTimeout", (...args) => { const timer = schedule(...args); timers.add(timer); return timer })
  t.mock.method(globalThis, "clearTimeout", (timer) => { timers.delete(timer); return clear(timer) })
  const second = await installer(options)
  assert.deepEqual(second, first)
  assert.equal(calls.filter(({ args }) => args.includes("ci")).length, 1)
  assert.equal(timers.size, 0, "reuse must not leave the five-minute timer alive")
})

test("concurrent matching installs publish one verified tree without replacement", { timeout: testTimeout }, async (t) => {
  const { options } = await fixture(t)
  const results = await Promise.all([installer(options), installer(options)])
  assert.deepEqual(results[0], results[1])
  const entries = await fs.readdir(join(options.destination, `v${version}`))
  assert.equal(entries.filter((name) => name.startsWith(".runtime-")).length, 1)
})

for (const mutation of ["version", "integrity", "extra", "missing", "lifecycle"]) {
  test(`refuses an existing runtime with ${mutation} drift instead of replacing it`, { timeout: testTimeout }, async (t) => {
    const { options } = await fixture(t)
    const result = await installer(options)
    const root = result.runtimePath
    const receipt = await fs.readFile(join(options.destination, `v${version}`, "runtime.json"))
    if (mutation === "version") await fs.writeFile(join(root, "node_modules/leaf/package.json"), JSON.stringify({ name: "leaf", version: "1.1.0" }))
    if (mutation === "integrity") {
      const path = join(root, "node_modules/.package-lock.json")
      const value = JSON.parse(await fs.readFile(path, "utf8"))
      value.packages["node_modules/leaf"].integrity = integrity("other")
      await fs.writeFile(path, JSON.stringify(value))
    }
    if (mutation === "extra") {
      await fs.mkdir(join(root, "node_modules/extra"))
      await fs.writeFile(join(root, "node_modules/extra/package.json"), JSON.stringify({ name: "extra", version: "1.0.0" }))
    }
    if (mutation === "missing") await fs.rm(join(root, "node_modules/leaf"), { recursive: true })
    if (mutation === "lifecycle") await fs.writeFile(join(root, "node_modules/leaf/package.json"), JSON.stringify({ name: "leaf", version: "1.0.0", scripts: { install: "fetch more code" } }))
    await assert.rejects(installer(options), /drift|integrity|Unrecorded|Missing required|lifecycle/)
    assert.deepEqual(await fs.readFile(join(options.destination, `v${version}`, "runtime.json")), receipt)
  })
}
