import assert from "node:assert/strict"
import test from "node:test"

import { bootstrapDeadline } from "./bootstrap-deadline.mjs"

const release = { commit: "a".repeat(40), version: "0.1.0-alpha.0", gitTag: "v0.1.0-alpha.0", prerelease: true,
  packages: ["protocol", "daemon"].map((name) => ({ name: `@getdomovoi/${name}`, version: "0.1.0-alpha.0", integrity: `sha512-${name}` })),
  files: [{ name: "SHA256SUMS", sha256: "b".repeat(64) }] }

function fixture(t, overrides = {}) {
  const writes = []
  const deadline = bootstrapDeadline(2_000, "release test deadline")
  t.after(() => deadline.clear())
  let record
  const request = async (path, method = "GET", body) => {
    if (method !== "GET") writes.push({ path, method, body })
    if (path === "/git/ref/tags/v0.1.0-alpha.0") return undefined
    if (path.startsWith("/releases/tags/")) return record
    if (path === "/releases?per_page=100") return []
    if (path === "/git/refs") return {}
    if (path === "/releases" && method === "POST") {
      record = { ...body, id: 12, assets: [] }
      return record
    }
    if (path === "/releases/12" && method === "PATCH") { Object.assign(record, body); return record }
    if (path === "/releases/12") return record
    assert.fail(`Unexpected GitHub request ${method} ${path}`)
  }
  const ports = {
    deadline, notes: "Reviewed changelogs.", request,
    readVersion: async (pkg) => ({ name: pkg.name, version: pkg.version,
      dist: { integrity: pkg.integrity, attestations: { url: "https://registry.npmjs.org/attestations", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } }),
    upload: async (id, file) => { writes.push({ upload: file.name }); record.assets.push({ name: file.name, digest: `sha256:${file.sha256}` }) },
    ...overrides,
  }
  return { writes, ports, publish: async () => (await import("./release-github.mjs")).publishCanonicalRelease(release, ports) }
}

test("creates the bootstrap tag at the checked commit and publishes only after every asset", async (t) => {
  const { writes, publish } = fixture(t)
  await publish()
  assert.deepEqual(writes[0], { path: "/git/refs", method: "POST", body: { ref: `refs/tags/${release.gitTag}`, sha: release.commit } })
  const create = writes.find((call) => call.path === "/releases")
  assert.equal(create.body.draft, true)
  assert.equal(create.body.prerelease, true)
  assert.equal(create.body.make_latest, "false")
  assert.match(create.body.body, new RegExp(release.commit))
  assert.deepEqual(writes.at(-1), { path: "/releases/12", method: "PATCH", body: { draft: false, make_latest: "false" } })
  assert.ok(writes.findIndex((call) => call.upload) < writes.length - 1)
})

for (const broken of [
  () => undefined,
  (pkg) => ({ name: pkg.name, version: pkg.version, dist: { integrity: "different" } }),
  (pkg) => ({ name: pkg.name, version: pkg.version, dist: { integrity: pkg.integrity } }),
]) {
  test("an absent, different or unattested npm artifact creates no tag or release", async (t) => {
    const { writes, publish } = fixture(t, { readVersion: async (pkg) => broken(pkg) })
    await assert.rejects(publish(), /npm|provenance|integrity/)
    assert.deepEqual(writes, [])
  })
}

test("an existing tag at another commit is never moved", async (t) => {
  const { writes, ports, publish } = fixture(t)
  const request = ports.request
  ports.request = (path, ...args) => path.startsWith("/git/ref/") ? { object: { type: "commit", sha: "c".repeat(40) } } : request(path, ...args)
  await assert.rejects(publish(), /another commit/)
  assert.deepEqual(writes, [])
})

test("a failed tag lookup is unknown, not permission to create one", async (t) => {
  const { writes, publish } = fixture(t, { request: async () => { throw new Error("GitHub 503") } })
  await assert.rejects(publish(), /503/)
  assert.deepEqual(writes, [])
})

test("a conflicting asset is never overwritten", async (t) => {
  const { writes, ports, publish } = fixture(t)
  const request = ports.request
  ports.request = (path, ...args) => path.startsWith("/releases/tags/")
    ? { id: 12, draft: true, prerelease: true, body: `Source commit: ${release.commit}`, assets: [{ name: "SHA256SUMS", digest: "sha256:wrong" }] }
    : request(path, ...args)
  await assert.rejects(publish(), /asset.*different|asset.*checksum/i)
  assert.equal(writes.some((call) => call.upload || call.method === "PATCH"), false)
})

test("a late registry response cannot create a release after the deadline", async (t) => {
  const { writes, publish } = fixture(t, { readVersion: async () => new Promise(() => {}) })
  await assert.rejects(publish(), /deadline/)
  assert.deepEqual(writes, [])
})
