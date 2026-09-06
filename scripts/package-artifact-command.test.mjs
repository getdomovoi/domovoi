import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { pnpmInvocation } from "./package-artifact-command.mjs"

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

test("resolves the pnpm executable without a shell on Windows", () => {
  const executable = String.raw`C:\Program Files\pnpm\pnpm.exe`

  assert.deepEqual(pnpmInvocation("win32", () => executable), {
    command: executable,
    shell: false,
  })
})

test("executes pnpm directly on Unix platforms", () => {
  assert.deepEqual(pnpmInvocation("linux"), { command: "pnpm", shell: false })
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
