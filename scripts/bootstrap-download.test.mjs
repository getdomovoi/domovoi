import assert from "node:assert/strict"
import test from "node:test"

import { downloadOverHttps } from "./bootstrap-daemon.mjs"

const start = "https://releases.test/v0.1.0/getdomovoi-daemon-0.1.0.tgz"

function responder(pages) {
  const requested = []
  const fetchImpl = async (url, options) => {
    requested.push(url)
    assert.equal(options?.redirect, "manual")
    const page = pages[url]
    if (!page) throw new Error(`nothing serves ${url}`)
    return page()
  }
  return { fetchImpl, requested }
}

function redirect(location, status = 302) {
  return () => new Response(null, { status, headers: { location } })
}

function payload(body, headers = {}) {
  return () => new Response(body, { status: 200, headers })
}

test("downloads the bytes a release serves", async () => {
  const { fetchImpl } = responder({ [start]: payload("release bytes") })
  const bytes = await downloadOverHttps(start, { maximumBytes: 1024, fetch: fetchImpl })
  assert.equal(Buffer.from(bytes).toString(), "release bytes")
})

test("follows an https redirect to the storage host", async () => {
  const storage = "https://objects.test/archive.tgz"
  const { fetchImpl, requested } = responder({
    [start]: redirect(storage),
    [storage]: payload("release bytes"),
  })
  const bytes = await downloadOverHttps(start, { maximumBytes: 1024, fetch: fetchImpl })
  assert.equal(Buffer.from(bytes).toString(), "release bytes")
  assert.deepEqual(requested, [start, storage])
})

test("refuses a plaintext hop even when the chain ends on https", async () => {
  const plaintext = "http://objects.test/archive.tgz"
  const { fetchImpl, requested } = responder({
    [start]: redirect(plaintext),
    [plaintext]: redirect("https://objects.test/archive.tgz"),
  })
  await assert.rejects(
    downloadOverHttps(start, { maximumBytes: 1024, fetch: fetchImpl }),
    /not https/,
  )
  assert.deepEqual(requested, [start])
})

test("refuses a redirect that names no destination", async () => {
  const { fetchImpl } = responder({ [start]: () => new Response(null, { status: 302 }) })
  await assert.rejects(downloadOverHttps(start, { maximumBytes: 1024, fetch: fetchImpl }), /no destination/)
})

test("refuses a redirect loop rather than following it forever", async () => {
  const other = "https://releases.test/other"
  const { fetchImpl } = responder({ [start]: redirect(other), [other]: redirect(start) })
  await assert.rejects(downloadOverHttps(start, { maximumBytes: 1024, fetch: fetchImpl }), /redirect/)
})

test("refuses a response that declares more bytes than the bound", async () => {
  const { fetchImpl } = responder({ [start]: payload("release bytes", { "content-length": "4096" }) })
  await assert.rejects(
    downloadOverHttps(start, { maximumBytes: 16, fetch: fetchImpl }),
    /larger than/,
  )
})

test("stops reading a body that grows past the bound without declaring it", async () => {
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(8))
    },
    cancel() {
      cancelled = true
    },
  })
  const { fetchImpl } = responder({ [start]: () => new Response(body, { status: 200 }) })

  await assert.rejects(
    downloadOverHttps(start, { maximumBytes: 16, fetch: fetchImpl }),
    /larger than/,
  )
  assert.equal(cancelled, true)
})

test("reports a release the server refuses to serve", async () => {
  const { fetchImpl } = responder({ [start]: () => new Response("gone", { status: 404 }) })
  await assert.rejects(downloadOverHttps(start, { maximumBytes: 1024, fetch: fetchImpl }), /404/)
})

for (const url of ["http://releases.test/archive.tgz", "file:///tmp/archive.tgz", "not a url"]) {
  test(`refuses to start a download at ${JSON.stringify(url)}`, async () => {
    const requested = []
    const fetchImpl = async (target) => {
      requested.push(target)
      return new Response("bytes", { status: 200 })
    }
    await assert.rejects(
      downloadOverHttps(url, { maximumBytes: 1024, fetch: fetchImpl }),
      /https/,
    )
    assert.deepEqual(requested, [])
  })
}
