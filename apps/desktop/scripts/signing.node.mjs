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
const { signingConfiguration } = require("./scripts/signing-config.cjs")
const { verifyMacApplication, verifyWindowsFiles, verificationBudgetMs } = require("./scripts/signing-verify.cjs")
const apple = {
  CSC_LINK: "fixture-only-certificate",
  CSC_KEY_PASSWORD: "fixture-only-password",
  APPLE_ID: "fixture@example.invalid",
  APPLE_APP_SPECIFIC_PASSWORD: "fixture-only-notary-password",
  APPLE_TEAM_ID: "ABCDE12345",
}
const azure = {
  AZURE_TENANT_ID: "fixture-tenant", AZURE_CLIENT_ID: "fixture-client", AZURE_CLIENT_SECRET: "fixture-only-secret",
  AZURE_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net", AZURE_SIGNING_ACCOUNT: "fixture-account",
  AZURE_SIGNING_PROFILE: "fixture-profile", DOMOVOI_WIN_PUBLISHER_NAME: "Fixture Publisher",
}
const certificate = {
  WIN_CSC_LINK: "fixture-only-pfx", WIN_CSC_KEY_PASSWORD: "fixture-only-password",
  DOMOVOI_WIN_PUBLISHER_NAME: "Fixture Publisher",
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

test("no credentials means explicit development settings, not keychain auto-discovery", () => {
  const config = signingConfiguration({}, "darwin")
  assert.equal(config.mac.identity, "-")
  assert.equal(config.mac.notarize, false)
  assert.equal(config.mac.hardenedRuntime, false)
  assert.equal(config.win.signExecutable, false)
  assert.equal(config.win.forceCodeSigning, false)
})

for (const [platform, env] of [["darwin", apple], ["win32", azure], ["win32", certificate]]) {
  for (const key of Object.keys(env)) {
    test(`partial ${platform} signing refuses missing ${key}`, () => {
      assert.throws(() => signingConfiguration({ ...env, [key]: "" }, platform), /signing|SIGNING|WIN_CSC_LINK/u)
    })
  }
}

test("required signing rejects absent credentials and unknown switch values", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.throws(() => signingConfiguration({ DOMOVOI_DESKTOP_REQUIRE_SIGNING: "true" }, platform), /requires complete signing credentials/u)
  }
  assert.throws(() => signingConfiguration({ DOMOVOI_DESKTOP_REQUIRE_SIGNING: "false" }, "darwin"), /must be true or unset/u)
})

test("ambiguous, disabled and unsupported signing inputs fail without leaking secrets", () => {
  for (const [env, platform] of [
    [{ ...azure, ...certificate }, "win32"],
    [{ ...apple, CSC_NAME: "-" }, "darwin"],
    [{ ...apple, CSC_IDENTITY_AUTO_DISCOVERY: "false" }, "darwin"],
    [{ ...apple, APPLE_TEAM_ID: "wrong" }, "darwin"],
    [{ ...apple, APPLE_API_KEY: "fixture-only-private-key" }, "darwin"],
    [{ ...apple, GITHUB_EVENT_NAME: "pull_request" }, "darwin"],
    [{ ...azure, GITHUB_EVENT_NAME: "pull_request_target" }, "win32"],
    [{ ...azure, AZURE_SIGNING_ENDPOINT: "https://user:fixture-only-secret@eus.codesigning.azure.net" }, "win32"],
  ]) {
    assert.throws(() => signingConfiguration(env, platform), (error) => {
      assert.doesNotMatch(error.message, /fixture-only/u)
      return true
    })
  }
})

test("both Windows modes require signing, use SHA-256, and pass the real builder schema", async () => {
  for (const env of [azure, certificate]) {
    const config = await configured(env)
    assert.equal(config.win.forceCodeSigning, true)
    assert.equal(config.win.signExecutable, true)
    await validateConfiguration(config, { debug: () => {} })
    if (env === azure) {
      assert.equal(config.win.signtoolOptions, null)
      assert.equal(config.win.azureSignOptions.fileDigest, "SHA256")
      assert.equal(config.win.azureSignOptions.publisherName, azure.DOMOVOI_WIN_PUBLISHER_NAME)
      assert.match(config.win.azureSignOptions.ExcludeCredentials, /AzureCliCredential/u)
    } else {
      assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, ["sha256"])
      assert.equal(config.win.azureSignOptions, undefined)
    }
    assert.doesNotMatch(JSON.stringify(config), /fixture-only/u)
  }
})

function packContext(platform) {
  return { appOutDir: resolve("fixture-out"), electronPlatformName: platform, packager: { appInfo: { productFilename: "Domovoi" } } }
}

test("cross-host packaging refuses before the pack operation", () => {
  const config = signingConfiguration({}, "linux")
  config.beforePack(packContext("linux"))
  assert.throws(() => config.beforePack(packContext("darwin")), /target platform/u)
  assert.throws(() => config.beforePack(packContext("win32")), /target platform/u)
})

test("a skipped signing hook cannot produce a successful signed build", async () => {
  for (const [env, platform] of [[apple, "darwin"], [azure, "win32"]]) {
    const config = signingConfiguration(env, platform)
    await assert.rejects(config.afterAllArtifactBuild({ artifactPaths: ["Domovoi.exe", "Domovoi.dmg", "Domovoi.zip"] }), /no application passed/u)
  }
})

test("signer and notarizer refusals propagate and cannot mark the application verified", async () => {
  const refusal = new Error("signature or ticket invalid")
  for (const [env, platform] of [[apple, "darwin"], [azure, "win32"]]) {
    const fail = async () => { throw refusal }
    const config = signingConfiguration(env, platform, { verifyMacApplication: fail, verifyWindowsFiles: fail })
    await assert.rejects(config.afterSign(packContext(platform)), (error) => error === refusal)
    await assert.rejects(config.afterAllArtifactBuild({ artifactPaths: [] }), /no application passed/u)
  }
})

test("Windows verifies the application and every final installer before success", async () => {
  const calls = []
  const config = signingConfiguration(azure, "win32", { verifyWindowsFiles: async (...args) => { calls.push(args) } })
  await config.afterSign(packContext("win32"))
  await config.afterAllArtifactBuild({ artifactPaths: ["one.exe", "one.exe.blockmap", "two.exe"] })
  assert.deepEqual(calls, [
    [[resolve("fixture-out", "Domovoi.exe")], "Fixture Publisher"],
    [["one.exe", "two.exe"], "Fixture Publisher"],
  ])
  await assert.rejects(config.afterAllArtifactBuild({ artifactPaths: [] }), /no NSIS installer/u)
})

test("macOS verifies the application and requires both distribution formats", async () => {
  const calls = []
  const config = signingConfiguration(apple, "darwin", { verifyMacApplication: async (...args) => { calls.push(args) } })
  await config.afterSign(packContext("darwin"))
  assert.deepEqual(calls, [[resolve("fixture-out", "Domovoi.app"), apple.APPLE_TEAM_ID]])
  await config.afterAllArtifactBuild({ artifactPaths: ["one.dmg", "one.zip"] })
  await assert.rejects(config.afterAllArtifactBuild({ artifactPaths: ["one.zip"] }), /both DMG and ZIP/u)
})

test("macOS checks nested signatures, Developer ID team and the stapled ticket in order", async () => {
  const calls = []
  let clock = 0
  await verifyMacApplication("/fixture/Domovoi.app", apple.APPLE_TEAM_ID, async (...args) => {
    calls.push(args)
    clock += 1000
    return { stdout: "", stderr: "Authority=Developer ID Application: Fixture\nTeamIdentifier=ABCDE12345\n" }
  }, () => clock)
  assert.deepEqual(calls.map(([command, args]) => [command, ...args.slice(0, 2)]), [
    ["/usr/bin/codesign", "--verify", "--deep"],
    ["/usr/bin/codesign", "--display", "--verbose=4"],
    ["/usr/bin/xcrun", "stapler", "validate"],
  ])
  assert.deepEqual(calls.map(([, , options]) => options.timeout), [120_000, 119_000, 118_000])
  await assert.rejects(verifyMacApplication("/fixture/Domovoi.app", apple.APPLE_TEAM_ID,
    async () => ({ stdout: "", stderr: "TeamIdentifier=OTHER12345\n" })), /Developer ID Application/u)
})

test("late verification cannot advance to the next command or return success", async () => {
  let calls = 0
  let clock = 0
  await assert.rejects(verifyWindowsFiles(["one.exe", "two.exe"], "Fixture", async () => {
    calls += 1
    clock = verificationBudgetMs
    return { stdout: "", stderr: "" }
  }, () => clock), /deadline/u)
  assert.equal(calls, 1)
})

test("Windows verification uses literal script arguments and propagates native failure", async () => {
  const refusal = new Error("Authenticode signature invalid")
  await assert.rejects(verifyWindowsFiles(["C:\\path with space\\Domovoi.exe"], "Publisher's name", async (command, args, options) => {
    assert.equal(command, "powershell.exe")
    assert.equal(args[2], "-File")
    assert.deepEqual(args.slice(-4), ["-Artifact", "C:\\path with space\\Domovoi.exe", "-Publisher", "Publisher's name"])
    assert.ok(options.timeout > 0 && options.timeout <= verificationBudgetMs)
    assert.equal(options.shell, undefined)
    throw refusal
  }), (error) => error === refusal)
})
