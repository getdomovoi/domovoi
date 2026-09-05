import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const publicApi = await import("./dist/public.js")
const { createProductionDaemon } = publicApi
const internal = await import("./dist/server.js")

// Published entry points cannot bypass production assembly. The internal path
// remains as a package-artifact compatibility surface, not a construction API.
assert.deepEqual(Object.keys(publicApi).sort(), ["acquireLocalDaemon", "createProductionDaemon"])
assert.equal("DomovoiDaemon" in internal, false)

const publicTypes = readFileSync(new URL("./dist/public.d.ts", import.meta.url), "utf8")
const internalTypes = readFileSync(new URL("./dist/server.d.ts", import.meta.url), "utf8")
assert.doesNotMatch(publicTypes, /\bDomovoiDaemon(?:Constructor|Instance|Options)?\b/)
assert.doesNotMatch(publicTypes, /\bDaemonServerOptions\b/)
assert.doesNotMatch(internalTypes, /\bDomovoiDaemon\b/)

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
assert.equal(manifest.engines.node, ">=22.13.0", "The daemon requires unflagged node:sqlite")

function runCli(...args) {
  return spawnSync(process.execPath, ["./dist/index.js", ...args], {
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
assert.match(help.stdout, /domovoid profile recover --confirm-no-supervisor/)
assert.match(help.stdout, /asserts that no supervisor will restart this profile/)
assert.match(help.stdout, /DOMOVOI_AUTH_TOKEN/)
assert.match(help.stdout, /DOMOVOI_CREDENTIAL_PATH/)
assert.match(help.stdout, /domovoid skill sign <skill-path> --key <private-key-path>/)
assert.match(runCli("-h").stdout, /^Usage: domovoid/m)

const unknown = runCli("--unknown")
assert.equal(unknown.status, 1, unknown.error?.message || unknown.stderr)
assert.match(unknown.stderr, /Unknown argument: --unknown/)

// Drive the distributed entry point, without touching the real OS keychain.
// A component-only command test would miss an unwired dispatch branch.
const recoveryHelp = runCli("fleet-keychain", "--help")
assert.equal(recoveryHelp.status, 0, recoveryHelp.error?.message || recoveryHelp.stderr)
assert.match(recoveryHelp.stdout, /--confirm-daemon-stopped/)
const invalidRecovery = runCli("fleet-keychain", "forget", "token=must-not-be-echoed", "--confirm-daemon-stopped")
assert.equal(invalidRecovery.status, 1)
assert.match(invalidRecovery.stderr, /Invalid machine identity/)
assert.doesNotMatch(invalidRecovery.stderr, /must-not-be-echoed/)

// The real packaged CLI must find and shut down its packaged worker. Substitute
// only the native binding, never open the operator's real OS keychain.
const keyringHome = mkdtempSync(join(tmpdir(), "domovoi-dist-keyring-"))
try {
  const listing = spawnSync(process.execPath, [
    "--import", new URL("./test-fixtures/blocked-keyring.mjs", import.meta.url).href,
    "./dist/index.js", "fleet-keychain", "list",
  ], { encoding: "utf8", timeout: 15_000, env: { ...process.env, DOMOVOI_TEST_KEYRING_DIRECTORY: keyringHome } })
  assert.equal(listing.status, 0, listing.error?.message || listing.stderr)
  assert.equal(listing.stdout, "")
  const events = readFileSync(join(keyringHome, "events"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.kind === "get"))
  assert.ok(events.every((event) => event.isMainThread === false))
} finally { rmSync(keyringHome, { recursive: true, force: true }) }
