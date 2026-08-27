import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

const { DomovoiDaemon } = await import("./dist/server.js")

const daemon = new DomovoiDaemon({ statePath: ":memory:" })
await daemon.stop()

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
assert.match(runCli("-h").stdout, /^Usage: domovoid/m)

const unknown = runCli("--unknown")
assert.equal(unknown.status, 1, unknown.error?.message || unknown.stderr)
assert.match(unknown.stderr, /Unknown argument: --unknown/)
