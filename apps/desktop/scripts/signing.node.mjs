import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(new URL("../package.json", import.meta.url))
const builderRequire = createRequire(require.resolve("electron-builder"))
const { getConfig, validateConfiguration } = builderRequire("app-builder-lib/out/util/config/config.js")
const apple = {
  CSC_LINK: "fixture-only-certificate",
  CSC_KEY_PASSWORD: "fixture-only-password",
  APPLE_ID: "fixture@example.invalid",
  APPLE_APP_SPECIFIC_PASSWORD: "fixture-only-notary-password",
  APPLE_TEAM_ID: "ABCDE12345",
}

// Read the entry the shipped package command actually uses. Before the change
// this loads the inert YAML, so the test fails on behavior, not a missing module.
async function configured(env) {
  const manifest = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"))
  const filename = manifest.scripts["package:mac"].match(/--config (\S+)/u)?.[1] ?? "electron-builder.yml"
  const keys = Object.keys(env)
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    Object.assign(process.env, env)
    const entry = resolve(desktopRoot, filename)
    if (filename.endsWith(".cjs")) delete require.cache[require.resolve(entry)]
    return await getConfig(desktopRoot, entry)
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

test("the packaging entry enables mandatory signing and notarization together", async () => {
  const config = await configured(apple)
  assert.equal(config.mac.notarize, true)
  assert.equal(config.mac.forceCodeSigning, true)
  assert.equal(config.mac.type, "distribution")
  assert.equal(config.mac.hardenedRuntime, true)
  assert.equal(config.mac.entitlements, "build/entitlements.mac.plist")
  assert.equal(config.publish, null)
  await validateConfiguration(config, { debug: () => {} })
})

test("the packaging entry refuses a configured certificate without notarization credentials", async () => {
  await assert.rejects(configured({ ...apple, APPLE_APP_SPECIFIC_PASSWORD: "" }), /APPLE_APP_SPECIFIC_PASSWORD/u)
})

test("every packaging command loads the signing policy and never publishes", async () => {
  const manifest = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"))
  for (const name of ["package", "package:linux", "package:mac", "package:win"]) {
    assert.match(manifest.scripts[name], /--config electron-builder\.cjs/u, name)
    assert.match(manifest.scripts[name], /--publish never/u, name)
  }
})
