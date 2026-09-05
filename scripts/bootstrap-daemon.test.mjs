import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { bootstrapDaemon, maximumManifestBytes } from "./bootstrap-daemon.mjs"

const baseUrl = "https://github.com/getdomovoi/domovoi/releases/download"
const version = "0.1.0"
const archive = `getdomovoi-daemon-${version}.tgz`
const bytes = Buffer.from("a daemon release")
const digest = createHash("sha256").update(bytes).digest("hex")

test("root package checks include the publication regressions", { timeout: 10_000 }, async () => {
  // Keep this in the pre-existing suite. If the new suite leaves the command,
  // an assertion inside that omitted file would no longer run either.
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.match(manifest.scripts["test:packages"], /(?:^| )scripts\/bootstrap-publication\.test\.mjs(?: |$)/)
  assert.match(manifest.scripts["test:packages"], /(?:^| )scripts\/bootstrap-install\.test\.mjs(?: |$)/)
  assert.match(manifest.scripts["test:packages"], /(?:^| )scripts\/bootstrap-install-live\.test\.mjs(?: |$)/)
  assert.match(manifest.scripts["test:packages"], /(?:^| )scripts\/runtime-lock\.test\.mjs(?: |$)/)
})

async function destination() {
  return await mkdtemp(join(tmpdir(), "domovoi-bootstrap-"))
}

function downloader({ manifest = `${digest}  ${archive}\n`, payload = bytes } = {}) {
  const requested = []
  const download = async (url) => {
    requested.push(url)
    if (url.endsWith("SHA256SUMS")) return Buffer.from(manifest)
    return payload
  }
  return { download, requested }
}

test("installs the archive the pinned release published", async () => {
  const into = await destination()
  try {
    const { download, requested } = downloader()
    const result = await bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: digest })

    assert.equal(result.version, version)
    assert.equal(result.sha256, digest)
    assert.deepEqual(await readFile(result.path), bytes)
    assert.deepEqual(requested, [
      `${baseUrl}/v${version}/SHA256SUMS`,
      `${baseUrl}/v${version}/${archive}`,
    ])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("writes each archive chunk before requesting the next one", { timeout: 10_000 }, async (t) => {
  const into = await destination()
  const release = join(into, `v${version}`)
  const chunks = Array.from({ length: 4 }, (_, index) => Buffer.alloc(64 * 1024, index + 1))
  const expected = Buffer.concat(chunks)
  const expectedSha256 = createHash("sha256").update(expected).digest("hex")
  // Zero queued chunks makes pull the actual consumer boundary. Reusing the
  // backing buffer also catches a sink that retains views instead of writing.
  const reusable = new Uint8Array(chunks[0].length)
  let consumed = 0
  const body = new ReadableStream({
    async pull(controller) {
      if (consumed > 0) {
        const files = await readdir(release, { recursive: true }).catch(() => [])
        const partials = files.filter((file) => file.endsWith(".partial"))
        assert.equal(partials.length, 1, "a consumed chunk must reach private staging before the next read")
        assert.deepEqual(await readFile(join(release, partials[0])), expected.subarray(0, consumed * reusable.length))
      }
      if (consumed === chunks.length) {
        controller.close()
        return
      }
      reusable.set(chunks[consumed])
      consumed += 1
      controller.enqueue(reusable)
    },
  }, { highWaterMark: 0 })
  t.mock.method(globalThis, "fetch", async (url) => new Response(url.endsWith("SHA256SUMS")
    ? `${expectedSha256}  ${archive}\n`
    : body))
  try {
    const result = await bootstrapDaemon({ version, baseUrl, destination: into, expectedSha256 })
    assert.equal(consumed, chunks.length)
    assert.equal(result.sha256, expectedSha256)
    assert.deepEqual(await readFile(result.path), expected)
    assert.deepEqual(await readdir(release), [archive])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("retains only bounded chunk buffers across a large streamed archive", { timeout: 30_000 }, async (t) => {
  const into = await destination()
  try {
    const script = fileURLToPath(new URL("./test-fixtures/bootstrap-memory.mjs", import.meta.url))
    const result = await new Promise((settle, reject) => {
      execFile(process.execPath, ["--expose-gc", script, into], {
        timeout: 25_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      }, (error, stdout, stderr) => {
        if (error) { reject(new Error(`${error.message}\n${stderr}`, { cause: error })); return }
        try { settle(JSON.parse(stdout)) } catch (error) { reject(error) }
      })
    })
    assert.equal(result.archiveBytes, 64 * 1024 * 1024)
    assert.ok(result.maxBufferGrowthBytes < 8 * 1024 * 1024, JSON.stringify(result))
    t.diagnostic(JSON.stringify(result))
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

for (const declared of [true, false]) {
  test(`bounds the manifest separately before staging (${declared ? "declared" : "streamed"})`, { timeout: 10_000 }, async (t) => {
    const into = await destination()
    let cancelled = false
    let requested = 0
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    t.mock.method(globalThis, "fetch", async () => {
      requested += 1
      return new Response(body, { headers: declared ? { "content-length": String(maximumManifestBytes + 1) } : {} })
    })
    try {
      await assert.rejects(bootstrapDaemon({ version, baseUrl, destination: into, expectedSha256: digest }),
        new RegExp(`SHA256SUMS.*larger than ${maximumManifestBytes}`))
      assert.equal(cancelled, true)
      assert.equal(requested, 1, "an oversized manifest must not reach the archive fetch")
      assert.deepEqual(await readdir(into), [])
    } finally {
      await rm(into, { force: true, recursive: true })
    }
  })

  test(`cancels an oversized archive and removes its private staging (${declared ? "declared" : "streamed"})`,
    { timeout: 10_000 }, async (t) => {
      const into = await destination()
      let cancelled = false
      const body = new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(8)) },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 })
      t.mock.method(globalThis, "fetch", async (url) => url.endsWith("SHA256SUMS")
        ? new Response(`${digest}  ${archive}\n`)
        : new Response(body, { headers: declared ? { "content-length": "17" } : {} }))
      try {
        await assert.rejects(bootstrapDaemon({ version, baseUrl, destination: into, expectedSha256: digest, maximumBytes: 16 }), /larger than 16/)
        assert.equal(cancelled, true)
        assert.deepEqual(await readdir(join(into, `v${version}`)), [])
      } finally {
        await rm(into, { force: true, recursive: true })
      }
    })
}

test("expires a silent fetch and never stages its late result", { timeout: 10_000 }, async (t) => {
  const into = await destination()
  const pending = Promise.withResolvers()
  let signal
  let cancelled = false
  const calls = []
  t.mock.method(globalThis, "fetch", (url, options) => {
    calls.push(url)
    signal = options.signal
    return pending.promise
  })
  try {
    await assert.rejects(bootstrapDaemon({ version, baseUrl, destination: into, expectedSha256: digest, timeoutMs: 100 }),
      /Bootstrap exceeded 100 ms.*https:/)
    assert.equal(signal.aborted, true)
    const response = new Response(new ReadableStream({ cancel() { cancelled = true } }))
    pending.resolve(response)
    // Drain late promise continuations, not an elapsed-time assumption.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelled, true, "a fetch that ignores abort must lose its late body too")
    assert.equal(calls.length, 1)
    assert.deepEqual(await readdir(into), [])
  } finally {
    pending.resolve(new Response(null))
    await rm(into, { force: true, recursive: true })
  }
})

test("cancels trickling archive bytes at the original deadline", { timeout: 10_000 }, async (t) => {
  const into = await destination()
  let now = 0
  let cancelled = false
  let reads = 0
  t.mock.method(performance, "now", () => now)
  const body = new ReadableStream({
    pull(controller) {
      reads += 1
      if (reads === 1) controller.enqueue(new Uint8Array(8))
      else {
        now = 1_000
        controller.enqueue(new Uint8Array(8))
      }
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  t.mock.method(globalThis, "fetch", async (url) => new Response(url.endsWith("SHA256SUMS") ? `${digest}  ${archive}\n` : body))
  try {
    await assert.rejects(bootstrapDaemon({ version, baseUrl, destination: into, expectedSha256: digest, timeoutMs: 1_000 }),
      /exceeded 1000 ms/)
    assert.equal(cancelled, true)
    assert.equal(reads, 2, "trickling a chunk must not renew the deadline")
    await assert.rejects(readFile(join(into, `v${version}`, archive)), { code: "ENOENT" })
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

for (const stalled of ["manifest", "archive"]) {
  test(`passes the configured inactivity bound to the ${stalled} download before publication`, { timeout: 10_000 }, async (t) => {
    const into = await destination()
    let now = 0
    t.mock.method(performance, "now", () => now)
    t.mock.method(globalThis, "fetch", async (url) => {
      const manifest = url.endsWith("SHA256SUMS")
      if ((stalled === "manifest") === manifest) now += 100
      return new Response(manifest ? `${digest}  ${archive}\n` : bytes)
    })
    try {
      await assert.rejects(bootstrapDaemon({ version, baseUrl, destination: into, expectedSha256: digest,
        timeoutMs: 1_000, inactivityTimeoutMs: 100 }), { code: "BOOTSTRAP_DOWNLOAD_INACTIVE" })
      await assert.rejects(readFile(join(into, `v${version}`, archive)), { code: "ENOENT" })
    } finally { await rm(into, { force: true, recursive: true }) }
  })
}

for (const timeoutMs of [0, -1, Infinity, NaN, 0.5, 2_147_483_648]) {
  test(`refuses an invalid total budget before downloading: ${timeoutMs}`, async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("must validate before fetching"))
    await assert.rejects(bootstrapDaemon({ version, baseUrl, destination: "/unused", expectedSha256: digest, timeoutMs }),
      /timeout must be a positive integer/)
    assert.equal(fetch.mock.callCount(), 0)
  })
}

test("keeps the release in a directory named for its version", async () => {
  const into = await destination()
  try {
    const { download } = downloader()
    const result = await bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: digest })
    assert.equal(result.path, join(into, `v${version}`, archive))
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("leaves nothing on disk when the bytes do not match the manifest", async () => {
  const into = await destination()
  try {
    const { download } = downloader({ payload: Buffer.from("someone else's bytes") })
    await assert.rejects(
      bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: digest }),
      /does not match/,
    )
    assert.deepEqual(await readdir(join(into, `v${version}`)).catch(() => []), [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("leaves nothing on disk when the manifest does not cover the archive", async () => {
  const into = await destination()
  try {
    const { download } = downloader({ manifest: `${digest}  getdomovoi-daemon-9.9.9.tgz\n` })
    await assert.rejects(
      bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: digest }),
      /not listed/,
    )
    assert.deepEqual(await readdir(join(into, `v${version}`)).catch(() => []), [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("reads the manifest before it downloads the archive", async () => {
  const into = await destination()
  try {
    const requested = []
    const download = async (url) => {
      requested.push(url)
      throw new Error("the release is unreachable")
    }
    await assert.rejects(bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: digest }))
    assert.deepEqual(requested, [`${baseUrl}/v${version}/SHA256SUMS`])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("refuses an archive larger than a release could plausibly be", async () => {
  const into = await destination()
  try {
    const { download } = downloader({ payload: Buffer.alloc(9) })
    await assert.rejects(
      bootstrapDaemon({ version, baseUrl, destination: into, download, maximumBytes: 8, expectedSha256: digest }),
      /larger than/,
    )
    assert.deepEqual(await readdir(join(into, `v${version}`)).catch(() => []), [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("refuses an unpinned version before it downloads anything", async () => {
  const into = await destination()
  try {
    const { download, requested } = downloader()
    await assert.rejects(
      bootstrapDaemon({ version: "latest", baseUrl, destination: into, download, expectedSha256: digest }),
      /pinned/,
    )
    assert.deepEqual(requested, [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("reuses a completed download with the same verified digest", async () => {
  const into = await destination()
  try {
    const { download } = downloader()
    await bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: digest })
    const result = await bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: digest })
    assert.deepEqual(await readdir(join(into, `v${version}`)), [archive])
    assert.deepEqual(await readFile(result.path), bytes)
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("refuses an archive the release manifest vouches for but the caller did not pin", async () => {
  const into = await destination()
  try {
    const payload = Buffer.from("a release the caller never pinned")
    const served = createHash("sha256").update(payload).digest("hex")
    const { download } = downloader({ manifest: `${served}  ${archive}\n`, payload })
    await assert.rejects(
      bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: digest }),
      new RegExp(`pinned: expected ${digest}, downloaded ${served}`),
    )
    assert.deepEqual(await readdir(join(into, `v${version}`)).catch(() => []), [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("still refuses an archive the caller pinned when the release manifest disagrees", async () => {
  const into = await destination()
  try {
    const { download } = downloader({ manifest: `${"1".repeat(64)}  ${archive}\n` })
    await assert.rejects(
      bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: digest }),
      /does not match SHA256SUMS/,
    )
    assert.deepEqual(await readdir(join(into, `v${version}`)).catch(() => []), [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("refuses to download anything when the caller pins no sha256", async () => {
  const into = await destination()
  try {
    const { download, requested } = downloader()
    await assert.rejects(
      bootstrapDaemon({ version, baseUrl, destination: into, download }),
      /sha256/,
    )
    assert.deepEqual(requested, [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("refuses to download anything when the caller's pin is not a sha256", async () => {
  const into = await destination()
  try {
    const { download, requested } = downloader()
    await assert.rejects(
      bootstrapDaemon({ version, baseUrl, destination: into, download, expectedSha256: "abc" }),
      /sha256/,
    )
    assert.deepEqual(requested, [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("names every argument the command line needs when the pin is missing", async () => {
  const into = await destination()
  try {
    const script = fileURLToPath(new URL("./bootstrap-daemon.mjs", import.meta.url))
    const args = [script, version, "https://example.invalid/releases/download", into]
    const result = await new Promise((settle) => {
      execFile(process.execPath, args, (error, stdout, stderr) => {
        settle({ code: error?.code ?? 0, stdout, stderr })
      })
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Usage: .*<version> <baseUrl> <destination> <expectedSha256>/)
    assert.equal(result.stdout, "")
    assert.deepEqual(await readdir(into), [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})
