import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { DomovoiDaemon, createProductionDaemon } = await import("./dist/public.js")
const internal = await import("./dist/server.js")

// The published entry stays narrow; the injection seams stay reachable on the
// internal path the workspace and the tests use.
assert.deepEqual(
  Object.keys(await import("./dist/public.js")).sort(),
  ["DomovoiDaemon", "createProductionDaemon"],
)
assert.ok(internal.DomovoiDaemon)
assert.ok(Object.keys(internal).length > 10)

const daemon = new DomovoiDaemon({ statePath: ":memory:" })
assert.match(daemon.authToken, /^[A-Za-z0-9_-]{43}$/)
await daemon.stop()

const productionHome = mkdtempSync(join(tmpdir(), "domovoi-dist-factory-"))
try {
  const production = await createProductionDaemon({
    environment: {},
    homeDirectory: productionHome,
    machineLabel: "dist-test",
  })
  assert.match(production.authToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(production.secureTransport, false)
  await production.stop()
} finally {
  rmSync(productionHome, { force: true, recursive: true })
}

const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))

function runCli(argument) {
  return spawnSync(process.execPath, ["./dist/index.js", argument], {
    encoding: "utf8",
    timeout: 2_000,
  })
}

const version = runCli("--version")
assert.equal(version.status, 0, version.error?.message || version.stderr)
assert.equal(version.stdout.trim(), manifest.version)
assert.equal(runCli("-v").stdout.trim(), manifest.version)

const help = runCli("--help")
assert.equal(help.status, 0, help.error?.message || help.stderr)
assert.match(help.stdout, /^Usage: domovoid/m)
assert.match(help.stdout, /DOMOVOI_AUTH_TOKEN/)
assert.match(help.stdout, /DOMOVOI_CREDENTIAL_PATH/)
assert.match(runCli("-h").stdout, /^Usage: domovoid/m)

const unknown = runCli("--unknown")
assert.equal(unknown.status, 1, unknown.error?.message || unknown.stderr)
assert.match(unknown.stderr, /Unknown argument: --unknown/)
