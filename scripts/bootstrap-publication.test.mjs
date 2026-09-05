import assert from "node:assert/strict"
import { execFile } from "node:child_process"
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

function bootstrapChild(destination, bytes) {
  const script = `
    import { bootstrapDaemon } from ${JSON.stringify(new URL("./bootstrap-daemon.mjs", import.meta.url).href)}
    const [destination, encoded] = process.argv.slice(1)
    const bytes = Buffer.from(encoded, "base64")
    const sha256 = ${JSON.stringify(digest(bytes))}
    try {
      const result = await bootstrapDaemon({
        version: ${JSON.stringify(version)}, baseUrl: ${JSON.stringify(baseUrl)},
        destination, expectedSha256: sha256,
        download: async url => url.endsWith("SHA256SUMS")
          ? Buffer.from(sha256 + "  ${archive}\\n") : bytes,
      })
      console.log(JSON.stringify({ status: "fulfilled", value: result }))
    } catch (error) {
      console.log(JSON.stringify({ status: "rejected", message: error.message }))
    }
  `
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "--eval", script, destination, bytes.toString("base64")], {
      timeout: testTimeoutMs - 1_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) { reject(error); return }
      try { resolve(JSON.parse(stdout)) } catch (parseError) { reject(parseError) }
    })
  })
}

for (const sameBytes of [true, false]) {
  test(`separate processes publish ${sameBytes ? "matching" : "different"} pins without replacement`,
    { timeout: testTimeoutMs }, async (context) => {
      const destination = await fixture(context)
      const firstBytes = Buffer.from("first child release")
      const secondBytes = sameBytes ? firstBytes : Buffer.from("other child release")
      const results = await Promise.all([
        bootstrapChild(destination, firstBytes), bootstrapChild(destination, secondBytes),
      ])
      const winners = results.filter((result) => result.status === "fulfilled")
      assert.equal(winners.length, sameBytes ? 2 : 1, JSON.stringify(results))
      for (const result of winners) {
        assert.equal(digest(await fs.readFile(result.value.path)), result.value.sha256)
      }
      if (!sameBytes) assert.match(results.find((result) => result.status === "rejected").message, /different.*sha256/i)
      assert.deepEqual(await fs.readdir(join(destination, `v${version}`)), [archive])
    })
}

test("refuses unsupported atomic publication without falling back to replacement",
  { timeout: testTimeoutMs }, async (context) => {
    const destination = await fixture(context)
    context.mock.method(fs, "link", async () => { throw Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" }) })
    syncBuiltinESMExports()
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports() })
    await assert.rejects(bootstrapDaemon(input(destination, Buffer.from("release"))), /hard links unavailable/)
    assert.deepEqual(await fs.readdir(join(destination, `v${version}`)), [])
  })

test("cleans only its own failed staging write", { timeout: testTimeoutMs }, async (context) => {
  const destination = await fixture(context)
  const release = join(destination, `v${version}`)
  await fs.mkdir(release)
  const legacy = join(release, `${archive}.partial`)
  await fs.writeFile(legacy, "other unfinished download")
  const writeFile = fs.writeFile
  context.mock.method(fs, "writeFile", async (path) => {
    await writeFile(path, "incomplete bytes")
    throw new Error("disk full during staging")
  })
  syncBuiltinESMExports()
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(bootstrapDaemon(input(destination, Buffer.from("release"))), /disk full during staging/)
  assert.deepEqual(await fs.readdir(release), [`${archive}.partial`])
  assert.equal(await fs.readFile(legacy, "utf8"), "other unfinished download")
})

test("reports verified publication separately from failed staging cleanup",
  { timeout: testTimeoutMs }, async (context) => {
    const destination = await fixture(context)
    const bytes = Buffer.from("verified bytes")
    const rm = fs.rm
    context.mock.method(fs, "rm", async (path, options) => {
      if (String(path).endsWith("archive.partial")) throw new Error("cleanup denied")
      return rm(path, options)
    })
    syncBuiltinESMExports()
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports() })
    await assert.rejects(bootstrapDaemon(input(destination, bytes)), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /Archive verified at .*staging cleanup failed/)
      assert.match(error.message, /\.bootstrap-/)
      assert.match(error.message, /cleanup denied/)
      return true
    })
    assert.deepEqual(await fs.readFile(join(destination, `v${version}`, archive)), bytes)
  })

test("retains the primary publication error when cleanup also fails",
  { timeout: testTimeoutMs }, async (context) => {
    const destination = await fixture(context)
    const publicationError = new Error("publication failed")
    const cleanupError = new Error("cleanup failed")
    const rm = fs.rm
    context.mock.method(fs, "link", async () => { throw publicationError })
    context.mock.method(fs, "rm", async (path, options) => {
      if (String(path).endsWith("archive.partial")) throw cleanupError
      return rm(path, options)
    })
    syncBuiltinESMExports()
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports() })
    await assert.rejects(bootstrapDaemon(input(destination, Buffer.from("release"))), (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors[0].cause, publicationError)
      assert.equal(error.errors[1], cleanupError)
      assert.match(error.message, /publication failed/)
      assert.match(error.message, /\.bootstrap-/)
      return true
    })
  })

test("expiry during staging cannot publish when the late write settles",
  { timeout: testTimeoutMs }, async (context) => {
    const destination = await fixture(context)
    const release = join(destination, `v${version}`)
    await fs.mkdir(release)
    const directory = await fs.mkdtemp(join(release, ".bootstrap-"))
    const written = gate(context)
    const releaseWrite = gate(context)
    // Set up disk before starting the short budget. This tests a hung write,
    // not whether an idle runner can create a directory within half a second.
    context.mock.method(fs, "mkdir", async () => {})
    context.mock.method(fs, "mkdtemp", async () => directory)
    const link = context.mock.method(fs, "link", fs.link)
    const write = context.mock.method(fs, "writeFile", async () => {
      written.resolve()
      await releaseWrite.promise
    })
    syncBuiltinESMExports()
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports() })
    const result = settle(bootstrapDaemon({ ...input(destination, Buffer.from("release")), publicationTimeoutMs: 500 }))
    try {
      await written.promise
      const outcome = await result
      assert.equal(outcome.status, "rejected")
      assert.match(outcome.reason.message, /exceeded 500 ms/)
      assert.match(outcome.reason.message, /inspect.*before retrying/i)
    } finally {
      releaseWrite.resolve()
      await Promise.all([result, ...write.mock.calls.map((call) => call.result)])
    }
    assert.equal(link.mock.callCount(), 0)
    await assert.rejects(fs.lstat(join(destination, `v${version}`, archive)), { code: "ENOENT" })
  })

test("checks the clock at settlement even before the expiry timer runs",
  { timeout: testTimeoutMs }, async (context) => {
    const destination = await fixture(context)
    let now = 0
    context.mock.method(performance, "now", () => now)
    const writeFile = fs.writeFile
    context.mock.method(fs, "writeFile", async (...args) => {
      await writeFile(...args)
      now = 30_000
    })
    const link = context.mock.method(fs, "link", fs.link)
    syncBuiltinESMExports()
    context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports() })
    await assert.rejects(bootstrapDaemon(input(destination, Buffer.from("release"))), /exceeded 30000 ms/)
    assert.equal(link.mock.callCount(), 0)
    await assert.rejects(fs.lstat(join(destination, `v${version}`, archive)), { code: "ENOENT" })
  })

for (const timeoutMs of [undefined, 0, -1, Infinity, NaN, 0.5, 2_147_483_648]) {
  test(`publication cannot have an unbounded budget: ${timeoutMs}`, { timeout: testTimeoutMs }, async (context) => {
    const { publishBootstrapArchive } = await import("./bootstrap-publication.mjs")
    const destination = await fixture(context)
    const bytes = Buffer.from("release")
    await assert.rejects(publishBootstrapArchive({
      release: destination, path: join(destination, archive), bytes, sha256: digest(bytes), timeoutMs,
    }), /timeout must be a positive integer/)
    assert.deepEqual(await fs.readdir(destination), [])
  })
}

test("refuses a non-file destination instead of replacing it", { timeout: testTimeoutMs }, async (context) => {
  const destination = await fixture(context)
  const release = join(destination, `v${version}`)
  const path = join(release, archive)
  await fs.mkdir(path, { recursive: true })
  await assert.rejects(bootstrapDaemon(input(destination, Buffer.from("release"))), /not a regular file|without replacement/)
  assert.ok((await fs.lstat(path)).isDirectory())
  assert.deepEqual(await fs.readdir(release), [archive])
})
