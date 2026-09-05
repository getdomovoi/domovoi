import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { bootstrapDaemon } from "./bootstrap-daemon.mjs"

const testTimeoutMs = 15_000
const version = "0.1.0"
const baseUrl = "https://releases.test"
const archive = `getdomovoi-daemon-${version}.tgz`
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
const settle = (promise) => promise.then(
  (value) => ({ status: "fulfilled", value }),
  (reason) => ({ status: "rejected", reason }),
)

function gate(context) {
  const pending = Promise.withResolvers()
  const timer = setTimeout(() => pending.reject(new Error("Bootstrap test gate expired")), testTimeoutMs)
  context.after(() => clearTimeout(timer))
  return pending
}

function input(destination, bytes) {
  const expectedSha256 = digest(bytes)
  return {
    version, baseUrl, destination, expectedSha256,
    download: async (url) => url.endsWith("SHA256SUMS")
      ? Buffer.from(`${expectedSha256}  ${archive}\n`) : bytes,
  }
}

async function fixture(context) {
  const destination = await fs.mkdtemp(join(tmpdir(), "domovoi-bootstrap-publish-"))
  context.after(() => fs.rm(destination, { recursive: true, force: true }))
  return destination
}

for (const sameBytes of [false, true]) {
  test(`isolates overlapping verified downloads with ${sameBytes ? "matching" : "different"} pins`,
    { timeout: testTimeoutMs }, async (context) => {
      const destination = await fixture(context)
      const firstBytes = Buffer.from("first verified release")
      const secondBytes = sameBytes ? firstBytes : Buffer.from("other verified release")
      const firstWritten = gate(context)
      const secondWritten = gate(context)
      const releaseSecond = gate(context)
      const writeFile = fs.writeFile
      let writes = 0
      // Real filesystem operations, only their settlements are gated. Force the
      // second write between the first write and its publication. With the old
      // shared .partial path, the first result names the second caller's bytes.
      context.mock.method(fs, "writeFile", async (path, bytes, options) => {
        await writeFile(path, bytes, options)
        if (!String(path).endsWith(".partial")) return
        writes += 1
        if (writes === 1) {
          firstWritten.resolve()
          await secondWritten.promise
        } else if (writes === 2) {
          secondWritten.resolve()
          await releaseSecond.promise
        }
      })
      syncBuiltinESMExports()
      context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports() })

      const first = settle(bootstrapDaemon(input(destination, firstBytes)))
      let second
      let firstResult
      let observed
      try {
        await firstWritten.promise
        second = settle(bootstrapDaemon(input(destination, secondBytes)))
        firstResult = await first
        if (firstResult.status === "fulfilled") observed = await fs.readFile(firstResult.value.path)
      } finally {
        firstWritten.resolve()
        secondWritten.resolve()
        releaseSecond.resolve()
        await Promise.all([first, second])
      }
      assert.equal(firstResult.status, "fulfilled", firstResult.reason?.stack)
      assert.deepEqual(observed, firstBytes, "the winner must publish its own verified bytes")
      const secondResult = await second
      if (sameBytes) {
        assert.equal(secondResult.status, "fulfilled", secondResult.reason?.stack)
        assert.deepEqual(secondResult.value, firstResult.value)
      } else {
        assert.equal(secondResult.status, "rejected")
        assert.match(secondResult.reason.message, /already exists.*different.*sha256/i)
      }
      assert.deepEqual(await fs.readFile(firstResult.value.path), firstBytes)
      assert.deepEqual(await fs.readdir(join(destination, `v${version}`)), [archive])
    })
}

test("refuses to replace an existing archive with another independently verified release",
  { timeout: testTimeoutMs }, async (context) => {
    const destination = await fixture(context)
    const original = Buffer.from("original release")
    const replacement = Buffer.from("replacement release")
    const first = await bootstrapDaemon(input(destination, original))
    await assert.rejects(bootstrapDaemon(input(destination, replacement)), /already exists.*different.*sha256/i)
    assert.deepEqual(await fs.readFile(first.path), original)
    assert.deepEqual(await fs.readdir(join(destination, `v${version}`)), [archive])
  })

test("leaves a legacy shared partial file untouched", { timeout: testTimeoutMs }, async (context) => {
  const destination = await fixture(context)
  const release = join(destination, `v${version}`)
  await fs.mkdir(release)
  const legacy = join(release, `${archive}.partial`)
  await fs.writeFile(legacy, "another invocation's unfinished bytes")
  const result = await bootstrapDaemon(input(destination, Buffer.from("verified release")))
  assert.equal(await fs.readFile(legacy, "utf8"), "another invocation's unfinished bytes")
  assert.equal(await fs.readFile(result.path, "utf8"), "verified release")
})
