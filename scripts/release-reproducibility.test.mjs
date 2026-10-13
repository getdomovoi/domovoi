import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const sha = (value) => createHash("sha256").update(value).digest("hex")
const version = "0.1.0-alpha.0"
const commit = "a".repeat(40)
const sourceFiles = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".github/workflows/release.yml"]

export async function comparisonFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-reproducibility-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, ".github/workflows"), { recursive: true })
  const inputs = { commit, tree: "b".repeat(40), version, files: [],
    toolchain: { node: "22.16.0", pnpm: "11.5.3", platform: "linux", arch: "x64", versions: { node: "22.16.0", v8: "12.4.254.21-node.26" } },
    environment: { TZ: "UTC", LC_ALL: "C", SOURCE_DATE_EPOCH: "1700000000" } }
  for (const name of sourceFiles) {
    const bytes = name === "package.json" ? JSON.stringify({ packageManager: "pnpm@11.5.3" }) : `synthetic ${name}\n`
    await writeFile(join(root, name), bytes)
    inputs.files.push({ name, sha256: sha(bytes) })
  }
  const names = ["protocol", "credential-store", "daemon", "cli"].flatMap((name) => [
    `getdomovoi-${name}-${version}.tgz`, `getdomovoi-${name}-${version}.sbom.json`,
  ]).concat(`domovoi-web-${version}.tar.gz`, "SHA256SUMS").sort()
  const artifacts = names.map((name) => ({ name, sha256: sha(`synthetic ${name}`), size: Buffer.byteLength(`synthetic ${name}`) }))
  for (const slot of ["a", "b"]) {
    await mkdir(join(root, slot))
    for (const { name } of artifacts) await writeFile(join(root, slot, name), `synthetic ${name}`)
    await writeFile(join(root, slot, "build.json"), JSON.stringify({ schemaVersion: 1, inputs, producer: { kind: "local", runId: "synthetic-run", slot, workspaceId: slot.repeat(64) }, artifacts }))
  }
  const args = { root, first: join(root, "a"), second: join(root, "b"), destination: join(root, "release"), commit }
  return { root, inputs, artifacts, args,
    compare: async () => (await import("./release-reproducibility.mjs")).compareReleaseBuilds(args),
    verify: async () => (await import("./release-reproducibility.mjs")).verifyReleaseReproducibility({ root, directory: args.destination, commit, version }) }
}

test("comparison copies exactly the independently matched bytes and verifies them again", async (t) => {
  const f = await comparisonFixture(t)
  const result = await f.compare()
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.builds.length, 2)
  assert.deepEqual(result.artifacts, f.artifacts)
  assert.deepEqual(await f.verify(), result)
  for (const { name } of f.artifacts) assert.deepEqual(await readFile(join(f.args.destination, name)), await readFile(join(f.args.first, name)))
})

for (const mutation of ["bytes", "missing", "extra", "symlink", "same producer", "same slot", "toolchain", "source", "receipt hash"]) {
  test(`comparison refuses ${mutation} before creating canonical output`, async (t) => {
    const f = await comparisonFixture(t)
    const name = f.artifacts[0].name
    const file = join(f.args.second, name)
    const receiptPath = join(f.args.second, "build.json")
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
    if (mutation === "bytes") await writeFile(file, "different bytes")
    if (mutation === "missing") await rm(file)
    if (mutation === "extra") await writeFile(join(f.args.second, "unexpected"), "extra")
    if (mutation === "symlink") { await rm(file); await symlink(join(f.args.first, name), file) }
    if (mutation === "same producer") receipt.producer.workspaceId = "a".repeat(64)
    if (mutation === "same slot") receipt.producer.slot = "a"
    if (mutation === "toolchain") receipt.inputs.toolchain.node = "22.17.0"
    if (mutation === "source") receipt.inputs.commit = "c".repeat(40)
    if (mutation === "receipt hash") receipt.artifacts[0].sha256 = "0".repeat(64)
    await writeFile(receiptPath, JSON.stringify(receipt))
    await assert.rejects(f.compare())
    await assert.rejects(readFile(join(f.args.destination, "reproducibility.json")), { code: "ENOENT" })
  })
}

test("verification refuses forged success, missing evidence and input or artifact drift", async (t) => {
  const f = await comparisonFixture(t)
  await f.compare()
  const evidence = join(f.args.destination, "reproducibility.json")
  const original = await readFile(evidence)
  await writeFile(evidence, JSON.stringify({ schemaVersion: 1, matched: true, commit }))
  await assert.rejects(f.verify())
  await rm(evidence)
  await assert.rejects(f.verify())
  await writeFile(evidence, original)
  await writeFile(join(f.root, "pnpm-lock.yaml"), "changed inputs")
  await assert.rejects(f.verify(), /input/i)
  await writeFile(join(f.root, "pnpm-lock.yaml"), "synthetic pnpm-lock.yaml\n")
  await writeFile(join(f.args.destination, f.artifacts[0].name), "changed payload")
  await assert.rejects(f.verify(), /artifact|digest/i)
})

test("comparison never overwrites an existing destination or accepts one candidate twice", async (t) => {
  const f = await comparisonFixture(t)
  const { compareReleaseBuilds } = await import("./release-reproducibility.mjs")
  await assert.rejects(compareReleaseBuilds({ ...f.args, second: f.args.first }))
  await mkdir(f.args.destination)
  await writeFile(join(f.args.destination, "keep"), "owned elsewhere")
  await assert.rejects(f.compare())
  assert.equal(await readFile(join(f.args.destination, "keep"), "utf8"), "owned elsewhere")
})


test("publication waits for two fresh build jobs and compares before preparing", async () => {
  const require = createRequire(new URL("../apps/daemon/package.json", import.meta.url))
  const { parse } = require("yaml")
  const workflow = parse(await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"))
  const build = workflow.jobs["pack-build"]
  assert.ok(build, "two independent jobs must build candidates")
  assert.deepEqual(build.strategy.matrix.slot, ["a", "b"])
  assert.equal(build.needs, "gate")
  assert.equal(build["runs-on"], "ubuntu-24.04")
  assert.deepEqual(build.permissions, { contents: "read" })
  assert.equal(build.steps.some((step) => step.uses?.startsWith("actions/cache@") || step.with?.cache), false)
  assert.equal(build.steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with["node-version"], "22.23.3")
  assert.ok(build.steps.some((step) => step.run?.includes("release-reproducibility.mjs build")))
  assert.deepEqual(workflow.jobs.pack.needs, ["gate", "pack-build"])
  const steps = workflow.jobs.pack.steps
  const compare = steps.findIndex((step) => step.run?.includes("release-reproducibility.mjs compare"))
  const prepare = steps.findIndex((step) => step.run === "pnpm release:prepare")
  assert.ok(compare >= 0 && compare < prepare)
  assert.equal(steps.some((step) => step.run === "pnpm release:artifacts"), false, "publication must reuse compared bytes")
  assert.equal(workflow.jobs.publish.needs, "pack")
})

test("a failed build command refuses and an aborted command stops its owned descendants", { timeout: 10_000 }, async (t) => {
  const { runBuildCommand } = await import("./release-reproducibility.mjs")
  assert.equal(typeof runBuildCommand, "function")
  const { bootstrapDeadline } = await import("./bootstrap-deadline.mjs")
  const deadline = bootstrapDeadline(5000, "command deadline")
  t.after(() => deadline.clear())
  if (process.platform === "win32") {
    await assert.rejects(runBuildCommand({ root: process.cwd(), executable: process.execPath, args: ["-e", ""], env: process.env, deadline }), /POSIX/)
    return
  }
  await assert.rejects(runBuildCommand({ root: process.cwd(), executable: process.execPath, args: ["-e", "process.exit(23)"], env: process.env, deadline }), /23/)
  const directory = await mkdtemp(join(tmpdir(), "domovoi-build-child-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const marker = join(directory, "writes")
  const controller = new AbortController()
  const childDeadline = { signal: controller.signal, check: () => controller.signal.throwIfAborted() }
  const grandchild = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),5)`
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`
  const running = runBuildCommand({ root: directory, executable: process.execPath, args: ["-e", parent], env: process.env, deadline: childDeadline })
  running.catch(() => {})
  for (;;) {
    deadline.check()
    try { if ((await readFile(marker)).length) break } catch (error) { if (error.code !== "ENOENT") throw error }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  controller.abort(new Error("synthetic abort"))
  await assert.rejects(running, /synthetic abort/)
  const after = await readFile(marker)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(await readFile(marker), after, "descendants cannot continue writing after cleanup is permitted")
})

test("observed Node component versions retain empty and build-metadata values", async (t) => {
  const f = await comparisonFixture(t)
  for (const directory of [f.args.first, f.args.second]) {
    const file = join(directory, "build.json")
    const receipt = JSON.parse(await readFile(file, "utf8"))
    receipt.inputs.toolchain.versions.openssl = "3.0.15+quic"
    receipt.inputs.toolchain.versions.nghttp3 = ""
    await writeFile(file, JSON.stringify(receipt))
  }
  assert.equal((await f.compare()).builds[0].inputs.toolchain.versions.nghttp3, "")
})


// This tiny tracked fixture executes the real installation/build wrapper. Its
// synthetic payloads test isolation/refusal, not product reproducibility.
test("fresh checkout execution observes private stores and refuses dirty or changed source", { timeout: 120_000 }, async (t) => {
  if (process.platform === "win32") {
    const { buildReleaseCandidate } = await import("./release-reproducibility.mjs")
    await assert.rejects(buildReleaseCandidate({ slot: "a", runId: "synthetic-run" }), /POSIX/)
    return
  }
  const exec = promisify(execFile)
  const root = await mkdtemp(join(tmpdir(), "domovoi-clean-build-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, "first")
  const second = join(root, "second")
  await mkdir(join(first, "scripts"), { recursive: true })
  await mkdir(join(first, "packages/protocol"), { recursive: true })
  await mkdir(join(first, ".github/workflows"), { recursive: true })
  for (const file of ["release-reproducibility.mjs", "bootstrap-deadline.mjs", "package-artifact-command.mjs", "release-packages.mjs"]) {
    await cp(new URL(file, import.meta.url), join(first, "scripts", file))
  }
  await writeFile(join(first, ".gitignore"), "node_modules/\nrelease/\n")
  await writeFile(join(first, "package.json"), JSON.stringify({ name: "synthetic-build", private: true, packageManager: "pnpm@11.5.3", scripts: { "release:artifacts": "node scripts/pack.mjs" } }))
  await writeFile(join(first, "packages/protocol/package.json"), JSON.stringify({ name: "synthetic-protocol", private: true, version }))
  await writeFile(join(first, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
  await writeFile(join(first, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/protocol: {}\n")
  await writeFile(join(first, ".github/workflows/release.yml"), "synthetic workflow\n")
  await writeFile(join(first, "scripts/pack.mjs"), `
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { releaseArtifactNames } from "./release-reproducibility.mjs"
const marker = join(process.env.PNPM_CONFIG_STORE_DIR, "fixture-marker")
if (existsSync(marker)) throw new Error("reused store")
mkdirSync(process.env.PNPM_CONFIG_STORE_DIR, { recursive: true })
writeFileSync(marker, "synthetic")
mkdirSync("release")
for (const name of releaseArtifactNames("${version}")) writeFileSync(join("release", name), "synthetic " + name)
`)
  const git = async (cwd, args) => exec("git", args, { cwd, encoding: "utf8", timeout: 10_000 })
  await git(first, ["init", "--quiet"])
  await git(first, ["add", "."])
  await git(first, ["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"])
  await git(root, ["clone", "--quiet", "--no-hardlinks", first, second])
  const changed = join(root, "changed")
  await git(root, ["clone", "--quiet", "--no-hardlinks", first, changed])
  const pack = join(changed, "scripts/pack.mjs")
  await writeFile(pack, `${await readFile(pack, "utf8")}
import { execFileSync } from "node:child_process"
writeFileSync("changed-source", "synthetic mutation")
execFileSync("git", ["add", "changed-source"])
execFileSync("git", ["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "mutation"])
`)
  await git(changed, ["add", "scripts/pack.mjs"])
  await git(changed, ["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture hook"])

  const build = async (directory, slot) => (await import(pathToFileURL(join(directory, "scripts/release-reproducibility.mjs")))).buildReleaseCandidate({ slot, runId: "synthetic-run", timeoutMs: 45_000 })
  const a = await build(first, "a")
  const b = await build(second, "b")
  assert.deepEqual(a.inputs, b.inputs)
  assert.deepEqual(a.artifacts, b.artifacts)
  assert.notEqual(a.producer.workspaceId, b.producer.workspaceId)
  await assert.rejects(build(changed, "a"), /source commit or tree/)
  await assert.rejects(build(first, "a"), /clean checkout/)
  await rm(join(second, "node_modules"), { recursive: true, force: true })
  await rm(join(second, "release"), { recursive: true, force: true })
  await writeFile(join(second, "untracked"), "contaminated")
  await assert.rejects(build(second, "b"), /clean checkout/)
})
