import assert from "node:assert/strict"
import test from "node:test"

import { bootstrapPlan, expectedChecksum, verifyDownload } from "./bootstrap-plan.mjs"

const releases = "https://github.com/getdomovoi/domovoi/releases/download"

test("pins the download to one released version", () => {
  assert.deepEqual(bootstrapPlan({ version: "0.1.0", baseUrl: releases }), {
    version: "0.1.0",
    archive: "getdomovoi-daemon-0.1.0.tgz",
    archiveUrl: `${releases}/v0.1.0/getdomovoi-daemon-0.1.0.tgz`,
    checksumUrl: `${releases}/v0.1.0/SHA256SUMS`,
  })
})

test("pins a prerelease exactly as it was published", () => {
  const plan = bootstrapPlan({ version: "0.1.0-alpha.1", baseUrl: releases })
  assert.equal(plan.archiveUrl, `${releases}/v0.1.0-alpha.1/getdomovoi-daemon-0.1.0-alpha.1.tgz`)
})

for (const version of ["latest", "^0.1.0", "0.1.x", "main", "", undefined]) {
  test(`refuses to install the moving version ${JSON.stringify(version)}`, () => {
    assert.throws(() => bootstrapPlan({ version, baseUrl: releases }), /pinned/)
  })
}

for (const baseUrl of ["http://example.test/download", "file:///tmp/download", "example.test"]) {
  test(`refuses to download over ${baseUrl}`, () => {
    assert.throws(() => bootstrapPlan({ version: "0.1.0", baseUrl }), /https/)
  })
}

const manifest = [
  "1111111111111111111111111111111111111111111111111111111111111111  getdomovoi-daemon-0.1.0.tgz\n",
  "2222222222222222222222222222222222222222222222222222222222222222  getdomovoi-protocol-0.1.0.tgz\n",
].join("")

test("reads the digest recorded for the pinned archive", () => {
  assert.equal(expectedChecksum(manifest, "getdomovoi-daemon-0.1.0.tgz"), "1".repeat(64))
})

test("refuses an archive the manifest does not cover", () => {
  assert.throws(() => expectedChecksum(manifest, "getdomovoi-daemon-0.2.0.tgz"), /not listed/)
})

test("refuses a manifest that lists the archive twice with different digests", () => {
  const conflicting = `${manifest}3333333333333333333333333333333333333333333333333333333333333333  getdomovoi-daemon-0.1.0.tgz\n`
  assert.throws(() => expectedChecksum(conflicting, "getdomovoi-daemon-0.1.0.tgz"), /listed twice/)
})

test("refuses a digest that is not a sha256", () => {
  const malformed = "abc  getdomovoi-daemon-0.1.0.tgz\n"
  assert.throws(() => expectedChecksum(malformed, "getdomovoi-daemon-0.1.0.tgz"), /sha256/)
})

test("accepts bytes whose digest matches the manifest", () => {
  assert.equal(verifyDownload({ file: "getdomovoi-daemon-0.1.0.tgz", manifest, digest: "1".repeat(64) }), true)
})

test("refuses bytes whose digest does not match the manifest", () => {
  assert.throws(
    () => verifyDownload({ file: "getdomovoi-daemon-0.1.0.tgz", manifest, digest: "4".repeat(64) }),
    /does not match/,
  )
})

for (const version of ["01.2.3", "1.02.3", "1.2.03", "1.2.3-alpha..1", "1.2.3-01", "1.2", "1.2.3.4"]) {
  test(`refuses the malformed version ${JSON.stringify(version)}`, () => {
    assert.throws(() => bootstrapPlan({ version, baseUrl: releases }), /pinned/)
  })
}

test("accepts a prerelease identifier that is allowed to be numeric zero", () => {
  const plan = bootstrapPlan({ version: "1.2.3-alpha.0", baseUrl: releases })
  assert.equal(plan.version, "1.2.3-alpha.0")
})

test("accepts build metadata alongside a prerelease", () => {
  const plan = bootstrapPlan({ version: "1.2.3-alpha.1+build.5", baseUrl: releases })
  assert.equal(plan.archive, "getdomovoi-daemon-1.2.3-alpha.1+build.5.tgz")
})

for (const baseUrl of [
  "https://",
  "ftps://example.test/download",
  "not a url",
  "https://example.test/download?ref=main",
  "https://example.test/download#fragment",
]) {
  test(`refuses the malformed download base ${JSON.stringify(baseUrl)}`, () => {
    assert.throws(() => bootstrapPlan({ version: "0.1.0", baseUrl }), /https|host|query|fragment/)
  })
}
