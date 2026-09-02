import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { bootstrapDaemon } from "./bootstrap-daemon.mjs"

const baseUrl = "https://github.com/getdomovoi/domovoi/releases/download"
const version = "0.1.0"
const archive = `getdomovoi-daemon-${version}.tgz`
const bytes = Buffer.from("a daemon release")
const digest = createHash("sha256").update(bytes).digest("hex")

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
    const result = await bootstrapDaemon({ version, baseUrl, destination: into, download })

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
    const result = await bootstrapDaemon({ version, baseUrl, destination: into, download })
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
      bootstrapDaemon({ version, baseUrl, destination: into, download }),
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
      bootstrapDaemon({ version, baseUrl, destination: into, download }),
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
    await assert.rejects(bootstrapDaemon({ version, baseUrl, destination: into, download }))
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
      bootstrapDaemon({ version, baseUrl, destination: into, download, maximumBytes: 8 }),
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
      bootstrapDaemon({ version: "latest", baseUrl, destination: into, download }),
      /pinned/,
    )
    assert.deepEqual(requested, [])
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})

test("replaces a partial download left by an interrupted install", async () => {
  const into = await destination()
  try {
    const { download } = downloader()
    await bootstrapDaemon({ version, baseUrl, destination: into, download })
    const result = await bootstrapDaemon({ version, baseUrl, destination: into, download })
    assert.deepEqual(await readdir(join(into, `v${version}`)), [archive])
    assert.deepEqual(await readFile(result.path), bytes)
  } finally {
    await rm(into, { force: true, recursive: true })
  }
})
