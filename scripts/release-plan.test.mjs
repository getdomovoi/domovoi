import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

const commit = "a".repeat(40)
const version = "0.1.0-alpha.0"
const directories = {
  "@getdomovoi/protocol": "packages/protocol",
  "@getdomovoi/credential-store": "packages/credential-store",
  "@getdomovoi/daemon": "apps/daemon",
  "@getdomovoi/cli": "apps/cli",
}
const names = Object.keys(directories)
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding)

export async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "domovoi release plan-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  const put = async (file, content) => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), typeof content === "string" ? content : JSON.stringify(content))
  }
  await put("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - apps/*\n")
  const sums = []
  const artifacts = []
  for (const [name, directory] of Object.entries(directories)) {
    await put(`${directory}/package.json`, { name, version, publishConfig: { access: "public", provenance: true } })
    await put(`${directory}/CHANGELOG.md`, `# ${name}\n\n## ${version}\n\nReviewed changes.\n`)
    const stem = `${name.slice(1).replace("/", "-")}-${version}`
    for (const [file, bytes] of [[`${stem}.tgz`, `packed ${name}`], [`${stem}.sbom.json`, JSON.stringify({ metadata: { component: { name, version } } })]]) {
      await put(`release/${file}`, bytes)
      sums.push(`${digest(bytes)}  ${file}\n`)
      artifacts.push({ name: file, sha256: digest(bytes), size: Buffer.byteLength(bytes) })
    }
  }
  const web = `domovoi-web-${version}.tar.gz`
  await put(`release/${web}`, "packed web app")
  sums.push(`${digest("packed web app")}  ${web}\n`)
  await put("release/SHA256SUMS", sums.sort().join(""))
  artifacts.push({ name: web, sha256: digest("packed web app"), size: Buffer.byteLength("packed web app") },
    { name: "SHA256SUMS", sha256: digest(sums.sort().join("")), size: Buffer.byteLength(sums.join("")) })
  artifacts.sort((a, b) => a.name < b.name ? -1 : 1)
  await put("package.json", { packageManager: "pnpm@11.5.3" })
  await put("pnpm-lock.yaml", "synthetic lock")
  await put(".github/workflows/release.yml", "synthetic workflow")
  const files = []
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".github/workflows/release.yml"]) {
    files.push({ name, sha256: digest(await readFile(join(root, name))) })
  }
  const inputs = { commit, tree: "b".repeat(40), version, files,
    toolchain: { node: "22.16.0", pnpm: "11.5.3", platform: "linux", arch: "x64", versions: { node: "22.16.0" } },
    environment: { TZ: "UTC", LC_ALL: "C", SOURCE_DATE_EPOCH: "1700000000" } }
  await put("release/reproducibility.json", { schemaVersion: 1, artifacts,
    builds: ["a", "b"].map((slot) => ({ schemaVersion: 1, inputs, artifacts,
      producer: { kind: "local", runId: "synthetic-run", slot, workspaceId: slot.repeat(64) } })) })
  const plan = { version: 1, plan: names.map((name) => [{ kind: "publish", name, version, access: "public", tag: "latest" }]) }
  await put("release/publish-plan.json", plan)
  const prepare = async () => (await import("./release-plan.mjs")).prepareRelease({ root, commit })
  const verify = async (sha = commit) => (await import("./release-plan.mjs")).verifyRelease({ root, commit: sha })
  return { root, put, plan, prepare, verify }
}

test("the packed plan uses reviewed bytes, ordered packages and the alpha tag", async (t) => {
  const { root, prepare, verify } = await releaseFixture(t)
  const result = await prepare()
  assert.equal(result.gitTag, `v${version}`)
  assert.equal(result.prerelease, true)
  assert.equal(result.commit, commit)
  assert.equal(result.npmTag, "alpha")
  const packed = JSON.parse(await readFile(join(root, "release/pack/publish-plan.json"), "utf8"))
  assert.deepEqual(packed.plan.map((chunk) => chunk.map((entry) => entry.name)), names.map((name) => [name]))
  for (const entry of packed.plan.flat()) {
    assert.equal(entry.tag, "alpha", "upstream's latest choice cannot promote an alpha")
    const original = await readFile(join(root, "release", entry.tarball.path.slice("packages/".length)))
    assert.deepEqual(await readFile(join(root, "release/pack", entry.tarball.path)), original)
    assert.equal(entry.tarball.integrity, `sha256-${digest(original, "sha256", "base64")}`)
  }
  assert.deepEqual(await verify(), result)
})

// release:github compares this value with npm's dist.integrity, which is the
// Subresource Integrity form of the tarball: sha512- and the base64 digest.
test("records each archive's integrity in the form npm reports", async (t) => {
  const { root, prepare } = await releaseFixture(t)
  const result = await prepare()
  assert.equal(result.packages.length, names.length)
  for (const pkg of result.packages) {
    const bytes = await readFile(join(root, "release", pkg.archive))
    assert.equal(pkg.integrity, `sha512-${digest(bytes, "sha512", "base64")}`, pkg.name)
  }
})

test("a changed archive refuses before a publish plan is written", async (t) => {
  const { root, put, prepare } = await releaseFixture(t)
  await put(`release/getdomovoi-daemon-${version}.tgz`, "substituted")
  await assert.rejects(prepare(), /SHA256SUMS|checksum/)
  await assert.rejects(readFile(join(root, "release/pack/publish-plan.json")), { code: "ENOENT" })
})

test("downloaded archive or plan drift refuses before publishing", async (t) => {
  const { root, put, prepare, verify } = await releaseFixture(t)
  await prepare()
  await put(`release/pack/packages/getdomovoi-daemon-${version}.tgz`, "substituted")
  await assert.rejects(verify(), /packed.*checksum/i)
  await prepare()
  const file = "release/pack/publish-plan.json"
  const packed = JSON.parse(await readFile(join(root, file), "utf8"))
  packed.plan[0][0].tag = "latest"
  await put(file, packed)
  await assert.rejects(verify(), /publish plan.*changed/i)
})

test("artifacts cannot be attached to another commit", async (t) => {
  const { prepare, verify } = await releaseFixture(t)
  await prepare()
  await assert.rejects(verify("b".repeat(40)), /release identity.*changed/i)
})

for (const mutation of [
  (plan) => plan.plan.reverse(),
  (plan) => { plan.plan[1][0].name = "@getdomovoi/ui" },
  (plan) => { plan.plan[1][0].version = "0.1.0-alpha.1" },
  (plan) => { plan.plan[1][0].access = "restricted" },
  (plan) => { plan.plan.push(plan.plan[0]) },
]) {
  test(`refuses malformed or unsafe publish planning: ${mutation}`, async (t) => {
    const { plan, put, prepare } = await releaseFixture(t)
    mutation(plan)
    await put("release/publish-plan.json", plan)
    await assert.rejects(prepare(), /publish|version|package|public/i)
  })
}

test("a retry can publish only the missing daemon while keeping every release artifact", async (t) => {
  const { plan, put, prepare } = await releaseFixture(t)
  plan.plan = plan.plan.filter(([entry]) => entry.name === "@getdomovoi/daemon")
  await put("release/publish-plan.json", plan)
  const result = await prepare()
  assert.deepEqual(result.packages.map((entry) => entry.name), names)
  assert.equal(result.files.length, names.length * 2 + 3)
})

// S3.2 slice 6: the web app is a release file beside the npm archives, never
// an npm package. release:github uploads every entry of files, so it must be
// named and checked there, and it never enters the publish plan.
test("the release carries the web app tarball, checked against SHA256SUMS and never published to npm", async (t) => {
  const { root, put, prepare } = await releaseFixture(t)
  const web = `domovoi-web-${version}.tar.gz`
  const result = await prepare()
  assert.deepEqual(result.files.find((file) => file.name === web), { name: web, sha256: digest("packed web app") })
  assert.equal(result.packages.some((pkg) => pkg.archive === web), false)
  const packed = JSON.parse(await readFile(join(root, "release/pack/publish-plan.json"), "utf8"))
  assert.equal(packed.plan.flat().some((entry) => entry.tarball.path.includes("domovoi-web")), false)
  await put(`release/${web}`, "substituted web app")
  await assert.rejects(prepare(), new RegExp(`${web.replaceAll(".", "\\.")} does not match SHA256SUMS`))
  await rm(join(root, "release", web))
  await assert.rejects(prepare(), /domovoi-web/)
})

test("preparing publication refuses missing independent-build evidence", async (t) => {
  const { root, prepare } = await releaseFixture(t)
  await rm(join(root, "release/reproducibility.json"), { force: true })
  await assert.rejects(prepare(), /reproducibility/)
  await assert.rejects(readFile(join(root, "release/pack/publish-plan.json")), { code: "ENOENT" })
})


test("publication rechecks comparison evidence and its canonical payload digests", async (t) => {
  const { root, put, prepare, verify } = await releaseFixture(t)
  const release = await prepare()
  assert.ok(release.files.some((file) => file.name === "reproducibility.json"))
  const evidence = JSON.parse(await readFile(join(root, "release/reproducibility.json"), "utf8"))
  evidence.builds[1].producer.workspaceId = evidence.builds[0].producer.workspaceId
  await put("release/reproducibility.json", evidence)
  await assert.rejects(verify(), /producer/)
  await assert.rejects(prepare(), /producer/)
})

async function distributionFixture(t) {
  const fixture = await releaseFixture(t)
  const legacy = await fixture.prepare()
  const legacyBytes = await readFile(join(fixture.root, "release/release.json"))
  const preparedDmgs = []
  for (const arch of ["arm64", "x64"]) {
    const name = `domovoi-desktop-${version}-${arch}.dmg`
    const bytes = `synthetic prepared ${arch} DMG; no native signing proof`
    await fixture.put(`prepared/${name}`, bytes)
    preparedDmgs.push({ path: join(fixture.root, "prepared", name), name, version, sourceCommit: commit,
      kind: "desktop", packageName: "@getdomovoi/desktop", platform: "darwin", arch, format: "dmg",
      bundleId: "sh.domovoi.desktop", app: "Domovoi.app", length: Buffer.byteLength(bytes), sha256: digest(bytes) })
  }
  const stage = async (overrides = {}) => (await import("./release-plan.mjs")).prepareDistributionInventory({
    root: fixture.root, commit, channel: "beta", stagingDirectory: join(fixture.root, "distribution"), preparedDmgs, ...overrides,
  })
  return { ...fixture, legacy, legacyBytes, preparedDmgs, stage }
}

test("distribution inventory stages exact core and prepared DMG bytes without changing the live release", async (t) => {
  const { root, legacy, legacyBytes, verify, stage } = await distributionFixture(t)
  const inventory = await stage()
  assert.equal(inventory.schemaVersion, 2)
  assert.equal(inventory.files.length, 13)
  assert.equal(inventory.commit, commit)
  assert.equal(inventory.channel, "beta")
  assert.equal(inventory.files.some((file) => file.name === "release.json"), false)
  for (const file of inventory.files) {
    const bytes = await readFile(join(root, "distribution", file.name))
    assert.equal(bytes.length, file.length)
    assert.equal(digest(bytes), file.sha256)
  }
  assert.deepEqual(JSON.parse(await readFile(join(root, "distribution/release.json"), "utf8")), inventory)
  assert.deepEqual(await readFile(join(root, "release/release.json")), legacyBytes)
  assert.deepEqual(await verify(), legacy)
  await assert.rejects(stage(), /exist/i)
  await writeFile(join(root, "release/release.json"), JSON.stringify(inventory))
  await assert.rejects(verify(), /changed after packing/, "schema2 cannot enter the unchanged live publisher through verifyRelease")
})

test("core-only distribution inventory does not claim native or additional reproducibility proof", async (t) => {
  const { root, stage } = await distributionFixture(t)
  const inventory = await stage({ preparedDmgs: [] })
  assert.equal(inventory.files.length, 11)
  assert.equal(inventory.files.some((file) => file.kind === "desktop"), false)
  assert.deepEqual(await readFile(join(root, "distribution/reproducibility.json")), await readFile(join(root, "release/reproducibility.json")))
})

test("prepared DMGs use the distribution byte bound instead of the small runtime JSON bound", async (t) => {
  const { preparedDmgs, stage } = await distributionFixture(t)
  const bytes = Buffer.alloc(33 * 1024 * 1024, 1)
  await writeFile(preparedDmgs[0].path, bytes)
  preparedDmgs[0].length = bytes.length
  preparedDmgs[0].sha256 = digest(bytes)
  const result = await stage()
  assert.equal(result.files.find((file) => file.arch === "arm64").length, bytes.length)
})

for (const target of ["release/release.json", "release/pack/publish-plan.json"]) {
  test(`distribution refuses a changed canonical input: ${target}`, async (t) => {
    const { put, stage } = await distributionFixture(t)
    await put(target, {})
    await assert.rejects(stage(), /changed after packing/i)
  })
}

for (const [label, change] of [
  ["changed hash", (inputs) => { inputs[0].sha256 = "0".repeat(64) }],
  ["changed length", (inputs) => { inputs[0].length++ }],
  ["wrong commit", (inputs) => { inputs[0].sourceCommit = "b".repeat(40) }],
  ["wrong app identity", (inputs) => { inputs[0].app = "Other.app" }],
  ["duplicate arch", (inputs) => { inputs[1] = inputs[0] }],
  ["unsafe name", (inputs) => { inputs[0].name = "../other.dmg" }],
]) {
  test(`distribution refuses ${label} without publishing an inventory`, async (t) => {
    const { root, preparedDmgs, stage } = await distributionFixture(t)
    change(preparedDmgs)
    await assert.rejects(stage(), /identity|duplicate|Invalid|invalid|match|unique/)
    await assert.rejects(readFile(join(root, "distribution/release.json")), { code: "ENOENT" })
  })
}
