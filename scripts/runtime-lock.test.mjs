import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"

const require = createRequire(new URL("../apps/daemon/package.json", import.meta.url))
const { parse } = require("yaml")
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`

function fixture() {
  return {
    manifest: { name: "@getdomovoi/daemon", version: "1.0.0", dependencies: { a: "^1.0.0", b: "^1.0.0", "@getdomovoi/protocol": "workspace:*" } },
    protocolManifest: { name: "@getdomovoi/protocol", version: "1.0.0", dependencies: { zod: "^4.0.0" } },
    protocolIntegrity: integrity,
    lock: {
      lockfileVersion: "9.0",
      importers: {
        "apps/daemon": { dependencies: {
          a: { specifier: "^1.0.0", version: "1.0.0" },
          b: { specifier: "^1.0.0", version: "1.0.0" },
          "@getdomovoi/protocol": { specifier: "workspace:*", version: "link:../../packages/protocol" },
        } },
        "packages/protocol": { dependencies: { zod: { specifier: "^4.0.0", version: "4.0.0" } } },
      },
      packages: Object.fromEntries(["a@1.0.0", "b@1.0.0", "leaf@1.0.0", "leaf@2.0.0", "zod@4.0.0", "native-win@1.0.0", "dev-only@1.0.0"]
        .map((name) => [name, { resolution: { integrity }, ...(name.startsWith("native-win") ? { os: ["win32"], cpu: ["x64"] } : {}) }])),
      snapshots: {
        "a@1.0.0": { dependencies: { leaf: "1.0.0" }, optionalDependencies: { "native-win": "1.0.0" } },
        "b@1.0.0": { dependencies: { leaf: "2.0.0" } },
        "leaf@1.0.0": {}, "leaf@2.0.0": {}, "zod@4.0.0": {}, "native-win@1.0.0": {}, "dev-only@1.0.0": {},
      },
    },
  }
}

async function generate(input) {
  // Dynamic import keeps a missing implementation an assertion failure, not a
  // module-loader crash before the red test can state what is missing.
  const module = await import("./runtime-lock.mjs").catch(() => ({}))
  assert.equal(typeof module.daemonRuntimeLock, "function", "daemon archives need a lock derived from the reviewed runtime graph")
  return module.daemonRuntimeLock(input)
}

test("freezes the complete graph, preserves version conflicts, and binds protocol bytes", async () => {
  const input = fixture()
  const result = await generate(input)
  assert.equal(result.lockfileVersion, 3)
  assert.equal(result.packages[""].dependencies["@getdomovoi/protocol"], "1.0.0")
  assert.equal(result.packages["node_modules/a"].dependencies.leaf, "1.0.0")
  assert.equal(result.packages["node_modules/leaf"].version, "1.0.0")
  assert.equal(result.packages["node_modules/b/node_modules/leaf"].version, "2.0.0")
  assert.deepEqual(result.packages["node_modules/native-win"].os, ["win32"])
  assert.equal(result.packages["node_modules/native-win"].optional, true)
  assert.equal(result.packages["node_modules/@getdomovoi/protocol"].resolved, "file:runtime/protocol.tgz")
  assert.equal(result.packages["node_modules/@getdomovoi/protocol"].integrity, integrity)
  assert.equal(result.packages["node_modules/dev-only"], undefined)
  assert.equal(result.packages["node_modules/zod"].integrity, integrity)
  for (const [path, entry] of Object.entries(result.packages)) {
    if (!path) continue
    assert.match(entry.integrity, /^sha512-/)
    assert.match(entry.version, /^\d+\.\d+\.\d+/)
  }
  assert.deepEqual(await generate(input), result, "generation must not consult changing registry metadata")
})

test("refuses stale importers, missing integrity, absent graph nodes, and unknown workspace links", async () => {
  for (const mutate of [
    (input) => { input.lock.importers["apps/daemon"].dependencies.a.specifier = "^2.0.0" },
    (input) => { delete input.lock.packages["leaf@1.0.0"].resolution.integrity },
    (input) => { delete input.lock.snapshots["leaf@1.0.0"] },
    (input) => { input.lock.importers["apps/daemon"].dependencies.a.version = "link:../../unknown" },
  ]) {
    const input = fixture()
    mutate(input)
    await assert.rejects(generate(input), /stale|integrity|missing|workspace/i)
  }
})

test("handles cyclic graphs and optional dependencies also reached by a required edge", async () => {
  const input = fixture()
  input.lock.snapshots["leaf@1.0.0"].dependencies = { a: "1.0.0" }
  input.lock.snapshots["b@1.0.0"].dependencies["native-win"] = "1.0.0"
  const result = await generate(input)
  assert.deepEqual(Object.keys(result.packages).sort(), [
    "", "node_modules/@getdomovoi/protocol", "node_modules/a", "node_modules/b",
    "node_modules/b/node_modules/leaf", "node_modules/leaf", "node_modules/native-win", "node_modules/zod",
  ])
  assert.notEqual(result.packages["node_modules/native-win"].optional, true)
})

test("covers the real daemon graph, including non-host native packages, without redistribution", async () => {
  const result = await generate({
    manifest: JSON.parse(await readFile(new URL("../apps/daemon/package.json", import.meta.url), "utf8")),
    protocolManifest: JSON.parse(await readFile(new URL("../packages/protocol/package.json", import.meta.url), "utf8")),
    lock: parse(await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8")),
    protocolIntegrity: `sha512-${createHash("sha512").update("same-release protocol tarball").digest("base64")}`,
  })
  for (const suffix of ["darwin-arm64", "win32-x64", "linux-x64-musl"]) {
    const entry = result.packages[`node_modules/@anthropic-ai/claude-agent-sdk-${suffix}`]
    assert.ok(entry, `missing cross-platform runtime dependency ${suffix}`)
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//)
    assert.match(entry.integrity, /^sha512-/)
  }
  assert.equal(result.packages["node_modules/@anthropic-ai/claude-agent-sdk"].version, "0.3.251")
  assert.equal(result.packages["node_modules/typescript"], undefined)
})
