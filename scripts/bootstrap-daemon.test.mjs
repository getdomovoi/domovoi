import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { bootstrapDaemon } from "./bootstrap-daemon.mjs"

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
