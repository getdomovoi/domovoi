import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

const commit = "a".repeat(40)
const version = "0.1.0-alpha.0"
const names = ["@getdomovoi/protocol", "@getdomovoi/daemon"]
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
  for (const [index, name] of names.entries()) {
    const directory = index === 0 ? "packages/protocol" : "apps/daemon"
    await put(`${directory}/package.json`, { name, version, publishConfig: { access: "public", provenance: true } })
    await put(`${directory}/CHANGELOG.md`, `# ${name}\n\n## ${version}\n\nReviewed changes.\n`)
    const stem = `${name.slice(1).replace("/", "-")}-${version}`
    for (const [file, bytes] of [[`${stem}.tgz`, `packed ${name}`], [`${stem}.sbom.json`, JSON.stringify({ metadata: { component: { name, version } } })]]) {
      await put(`release/${file}`, bytes)
      sums.push(`${digest(bytes)}  ${file}\n`)
    }
  }
  await put("release/SHA256SUMS", sums.sort().join(""))
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

test("a retry can publish only the missing daemon while keeping both release artifacts", async (t) => {
  const { plan, put, prepare } = await releaseFixture(t)
  plan.plan.shift()
  await put("release/publish-plan.json", plan)
  const result = await prepare()
  assert.deepEqual(result.packages.map((entry) => entry.name), names)
  assert.equal(result.files.length, 5)
})
