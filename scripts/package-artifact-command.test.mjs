import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { pnpmInvocation, windowsLookupTimeoutMs } from "./package-artifact-command.mjs"

const scriptDirectory = fileURLToPath(new URL("./", import.meta.url))
const packHelper = join(scriptDirectory, "pack-package.mjs")
const relativeImport = /(?:^|[\s;])(?:import|export)[^"'\n]*?from\s*["'](\.[^"']+)["']/g

// Every real pack runs the protocol prepack, which is tsup with --clean. That
// deletes and rewrites the one packages/protocol/dist the whole workspace
// shares, and it also rewrites apps/daemon/runtime. A second pack that cleans
// while the first is still reading its own build out of dist takes the file
// away underneath it, so packing tests cannot run beside each other.
async function moduleGraph(entry) {
  const reached = new Set()
  const pending = [entry]
  while (pending.length) {
    const file = pending.pop()
    if (reached.has(file)) continue
    reached.add(file)
    const source = await readFile(file, "utf8").catch(() => "")
    for (const [, specifier] of source.matchAll(relativeImport)) pending.push(resolve(dirname(file), specifier))
  }
  return reached
}

function testGroups(script) {
  return script
    .split("&&")
    .map((command) => command.trim().split(/\s+/))
    .filter((tokens) => tokens[0] === "node" && tokens.includes("--test"))
    .map((tokens) => ({
      serial: tokens.includes("--test-concurrency=1"),
      files: tokens.filter((token) => token.endsWith(".test.mjs")),
    }))
}

async function packageTestGroups() {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  const groups = testGroups(manifest.scripts["test:packages"])
  assert.ok(groups.length > 0, "test:packages must run the scripts suite")
  return groups
}

const refuseLookup = () => assert.fail("nothing may spawn a lookup once the launcher has named pnpm")

test("resolves the pnpm executable without a shell on Windows", () => {
  const executable = String.raw`C:\Program Files\pnpm\pnpm.exe`

  assert.deepEqual(pnpmInvocation("win32", { env: {}, lookup: () => `${executable}\r\n` }), {
    command: executable,
    args: [],
    shell: false,
  })
})

test("executes pnpm directly on Unix platforms", () => {
  assert.deepEqual(pnpmInvocation("linux"), { command: "pnpm", args: [], shell: false })
})

test("takes the pnpm that launched the process over asking Windows where it is", () => {
  const launcher = String.raw`C:\Users\runneradmin\setup-pnpm\pnpm.exe`

  assert.deepEqual(pnpmInvocation("win32", { env: { npm_execpath: launcher }, lookup: refuseLookup }), {
    command: launcher,
    args: [],
    shell: false,
  })
})

test("runs a launcher published as a script through the node that loaded it", () => {
  const launcher = String.raw`C:\Users\runneradmin\AppData\Local\node\corepack\pnpm\11.5.3\bin\pnpm.cjs`
  const node = String.raw`C:\Program Files\nodejs\node.exe`
  const env = { npm_execpath: launcher, npm_node_execpath: node }

  assert.deepEqual(pnpmInvocation("win32", { env, lookup: refuseLookup }), {
    command: node,
    args: [launcher],
    shell: false,
  })
})

test("ignores a launcher that is not pnpm", () => {
  const executable = String.raw`C:\Program Files\pnpm\pnpm.exe`
  const env = { npm_execpath: String.raw`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js` }

  assert.deepEqual(pnpmInvocation("win32", { env, lookup: () => `${executable}\r\n` }), {
    command: executable,
    args: [],
    shell: false,
  })
})

test("ignores a launcher Node cannot spawn without a shell", () => {
  const executable = String.raw`C:\Program Files\pnpm\pnpm.exe`
  const env = { npm_execpath: String.raw`C:\Users\runneradmin\AppData\Roaming\npm\pnpm.cmd` }

  assert.deepEqual(pnpmInvocation("win32", { env, lookup: () => `${executable}\r\n` }), {
    command: executable,
    args: [],
    shell: false,
  })
})

test("lets Windows resolve pnpm by name when the lookup stalls", (t) => {
  const warnings = []
  t.mock.method(console, "warn", (message) => warnings.push(message))
  const stalled = Object.assign(new Error("spawnSync where.exe ETIMEDOUT"), { code: "ETIMEDOUT" })

  assert.deepEqual(pnpmInvocation("win32", { env: {}, lookup: () => { throw stalled } }), {
    command: "pnpm",
    args: [],
    shell: false,
  })
  assert.deepEqual(warnings, [
    `where.exe did not name pnpm.exe within ${windowsLookupTimeoutMs} ms; running pnpm by name and letting Windows`
    + " resolve it from PATH",
  ])
})

test("says what it was looking for when the lookup answers that pnpm.exe is absent", () => {
  const missing = Object.assign(new Error("Command failed: where.exe pnpm.exe"), { status: 1 })

  assert.throws(() => pnpmInvocation("win32", { env: {}, lookup: () => { throw missing } }), {
    message: "where.exe found no pnpm.exe on PATH, so packing cannot run pnpm: Command failed: where.exe pnpm.exe",
    cause: missing,
  })
})

test("says what it was looking for when the lookup prints nothing", () => {
  assert.throws(() => pnpmInvocation("win32", { env: {}, lookup: () => "\r\n" }), {
    message: "where.exe found no pnpm.exe on PATH, so packing cannot run pnpm: where.exe printed no path",
  })
})

test("test:packages runs every scripts test exactly once", async () => {
  const listed = (await packageTestGroups()).flatMap((group) => group.files)
  const present = (await readdir(scriptDirectory))
    .filter((entry) => entry.endsWith(".test.mjs"))
    .map((entry) => `scripts/${entry}`)
  assert.deepEqual([...listed].sort(), present.sort(), "splitting the suite must not drop or duplicate a test file")
})

test("a scripts test that can pack the workspace never runs beside another", async () => {
  const groups = await packageTestGroups()
  const packing = []
  for (const group of groups) {
    for (const file of group.files) {
      if (!(await moduleGraph(join(scriptDirectory, basename(file)))).has(packHelper)) continue
      packing.push(file)
      assert.ok(group.serial,
        `${file} reaches the workspace pack helper, so it must run with --test-concurrency=1`)
    }
  }
  assert.ok(packing.includes("scripts/bootstrap-real-daemon.test.mjs"), "the real bootstrap test packs the workspace")
  assert.ok(packing.includes("scripts/release-artifacts.test.mjs"), "the release artifact test packs the workspace")
})
