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
assert.deepEqual(Object.keys(publicApi).sort(), ["createProductionDaemon"])
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
