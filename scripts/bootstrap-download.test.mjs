import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import test from "node:test"

import { downloadOverHttps as downloadChunksOverHttps } from "./bootstrap-daemon.mjs"
import { bootstrapDeadline } from "./bootstrap-deadline.mjs"

// Buffer only tiny test bodies. The production archive consumer writes chunks
// directly to staging; its streaming boundary is tested through bootstrapDaemon.
async function downloadOverHttps(url, options) {
  const deadline = bootstrapDeadline(5_000, `Test download expired: ${url}`)
  try {
    const chunks = []
    for await (const chunk of downloadChunksOverHttps(url, { ...options, deadline })) chunks.push(chunk)
    return Buffer.concat(chunks)
  } finally { deadline.clear() }
}

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

test("redirects spend the original deadline and cancel a late response without reading it", { timeout: 5_000 }, async (t) => {
  let now = 0
  let cancelled = 0
  let read = 0
  let transportSignal
  const requested = []
  t.mock.method(performance, "now", () => now)
  const deadline = bootstrapDeadline(1_000, "Original download budget expired")
  try {
    const fetchImpl = async (url, options) => {
      transportSignal ??= options.signal
      assert.equal(options.signal, transportSignal, "redirects must share one transport cancellation signal")
      requested.push(url)
      now += 500
      return new Response(new ReadableStream({
        pull(controller) { read += 1; controller.enqueue(new Uint8Array(1)) },
        cancel() { cancelled += 1 },
      }, { highWaterMark: 0 }), { status: 302, headers: { location: "https://objects.test/archive" } })
    }
    await assert.rejects(async () => {
      for await (const unused of downloadChunksOverHttps(start, { maximumBytes: 1, fetch: fetchImpl, deadline })) {
        assert.fail(`An expired redirect yielded ${unused.byteLength} bytes`)
      }
    }, /Original download budget expired/)
    assert.deepEqual(requested, [start, "https://objects.test/archive"])
    assert.equal(cancelled, 2)
    assert.equal(read, 0)
    assert.equal(transportSignal.aborted, true)
    assert.equal(transportSignal.reason, deadline.signal.reason, "the linked signal must preserve the total deadline refusal")
  } finally { deadline.clear() }
})

test("body cancellation cannot hang past the download budget", { timeout: 5_000 }, async () => {
  const deadline = bootstrapDeadline(100, "Body cancellation expired")
  let cancelled = false
  let requested = 0
  try {
    const fetchImpl = async () => {
      requested += 1
      return new Response(new ReadableStream({
        cancel() { cancelled = true; return new Promise(() => {}) },
      }), { status: 302, headers: { location: "https://objects.test/archive" } })
    }
    await assert.rejects(async () => {
      for await (const unused of downloadChunksOverHttps(start, { maximumBytes: 1, fetch: fetchImpl, deadline })) {
        assert.fail(`A stalled redirect yielded ${unused.byteLength} bytes`)
      }
    }, /Body cancellation expired/)
    assert.equal(cancelled, true)
    assert.equal(requested, 1)
  } finally { deadline.clear() }
})

test("a child phase cannot outlive its parent or run a late continuation", { timeout: 5_000 }, async (t) => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const parent = bootstrapDeadline(1_000, "Original bootstrap budget expired")
  now = 900
  const child = bootstrapDeadline(30_000, "Publication phase expired", parent)
  try {
    await assert.rejects(child.run(() => { now = 1_000; return "late publication" }), /Original bootstrap budget expired/)
    assert.equal(child.signal.aborted, true)
    let ran = false
    await assert.rejects(child.run(() => { ran = true }), /Original bootstrap budget expired/)
    assert.equal(ran, false)
  } finally { child.clear(); parent.clear() }
})

for (const phase of ["headers", "first body bytes", "redirects", "empty chunks"]) {
  test(`inactivity expires across ${phase} without accepting late bytes`, { timeout: 5_000 }, async (t) => {
    let now = 0
    let requests = 0
    let reads = 0
    const delivered = []
    t.mock.method(performance, "now", () => now)
    const deadline = bootstrapDeadline(1_000, "Original total expired")
    const fetchImpl = async () => {
      requests += 1
      if (phase === "headers") now = 100
      if (phase === "redirects") {
        now += 40
        if (requests < 3) return new Response(null, { status: 302, headers: { location: start } })
      }
      return new Response(new ReadableStream({
        pull(controller) {
          reads += 1
          if (phase === "first body bytes") now = 100
          if (phase === "empty chunks") {
            now += 40
            if (reads < 4) { controller.enqueue(new Uint8Array(0)); return }
          }
          controller.enqueue(new Uint8Array([1]))
          controller.close()
        },
      }, { highWaterMark: 0 }))
    }
    try {
      await assert.rejects(async () => {
        for await (const chunk of downloadChunksOverHttps(start, { maximumBytes: 8, fetch: fetchImpl, deadline, inactivityTimeoutMs: 100 })) {
          if (chunk.byteLength) delivered.push(chunk)
        }
      }, { code: "BOOTSTRAP_DOWNLOAD_INACTIVE" })
      assert.deepEqual(delivered, [], "a late result must not reach the consumer")
      assert.equal(deadline.signal.aborted, false, "inactivity must not rewrite the total budget")
    } finally { deadline.clear() }
  })
}

for (const phase of ["fetch", "body read"]) {
  test(`inactivity aborts a silent ${phase} even when the transport ignores cancellation`, { timeout: 5_000 }, async () => {
    const deadline = bootstrapDeadline(2_000, "Original total expired")
    let signal
    let cancelled = 0
    const fetchImpl = (_url, options) => {
      signal = options.signal
      if (phase === "fetch") return new Promise(() => {})
      return Promise.resolve(new Response(new ReadableStream({
        pull() { return new Promise(() => {}) },
        cancel() { cancelled += 1; return new Promise(() => {}) },
      }, { highWaterMark: 0 })))
    }
    try {
      await assert.rejects(async () => {
        for await (const chunk of downloadChunksOverHttps(start, { maximumBytes: 8, fetch: fetchImpl, deadline, inactivityTimeoutMs: 50 })) {
          assert.fail(`A silent response yielded ${chunk.byteLength} bytes`)
        }
      }, { code: "BOOTSTRAP_DOWNLOAD_INACTIVE" })
      assert.equal(signal.aborted, true)
      assert.equal(signal.reason.code, "BOOTSTRAP_DOWNLOAD_INACTIVE")
      if (phase === "body read") assert.equal(cancelled, 1)
    } finally { deadline.clear() }
  })
}

test("late inactivity headers are cancelled before the body is read", { timeout: 5_000 }, async (t) => {
  let now = 0
  let cancelled = 0
  let reads = 0
  t.mock.method(performance, "now", () => now)
  const deadline = bootstrapDeadline(1_000, "Original total expired")
  try {
    await assert.rejects(async () => {
      for await (const chunk of downloadChunksOverHttps(start, { maximumBytes: 8, inactivityTimeoutMs: 100, deadline,
        fetch: async () => {
          now = 100
          return new Response(new ReadableStream({
            pull() { reads += 1 },
            cancel() { cancelled += 1 },
          }, { highWaterMark: 0 }))
        },
      })) assert.fail(`Late headers yielded ${chunk.byteLength} bytes`)
    }, { code: "BOOTSTRAP_DOWNLOAD_INACTIVE" })
    assert.equal(cancelled, 1)
    assert.equal(reads, 0)
  } finally { deadline.clear() }
})

test("headers and the first body read cannot each claim a fresh inactivity budget", { timeout: 5_000 }, async (t) => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const deadline = bootstrapDeadline(1_000, "Original total expired")
  try {
    await assert.rejects(async () => {
      for await (const chunk of downloadChunksOverHttps(start, { maximumBytes: 8, inactivityTimeoutMs: 100, deadline,
        fetch: async () => {
          now += 60
          return new Response(new ReadableStream({
            pull(controller) { now += 60; controller.enqueue(new Uint8Array([1])); controller.close() },
          }, { highWaterMark: 0 }))
        },
      })) assert.fail(`An expired first read yielded ${chunk.byteLength} bytes`)
    }, { code: "BOOTSTRAP_DOWNLOAD_INACTIVE" })
  } finally { deadline.clear() }
})

test("inactivity reports the origin and remedy without echoing URL secrets", { timeout: 5_000 }, async (t) => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const deadline = bootstrapDeadline(1_000, "Original total expired")
  try {
    await assert.rejects(async () => {
      for await (const chunk of downloadChunksOverHttps("https://person:credential@releases.test/private-path?token=secret", {
        maximumBytes: 8, inactivityTimeoutMs: 100, deadline,
        fetch: async () => { now = 100; return new Response(null) },
      })) assert.fail(`An expired request yielded ${chunk.byteLength} bytes`)
    }, (error) => {
      assert.equal(error.code, "BOOTSTRAP_DOWNLOAD_INACTIVE")
      assert.equal(error.inactivityTimeoutMs, 100)
      assert.match(error.message, /https:\/\/releases\.test.*100 ms.*check the connection and retry/)
      assert.doesNotMatch(error.message, /person|credential|private-path|secret/)
      return true
    })
  } finally { deadline.clear() }
})

test("body bytes replenish inactivity without charging local consumer backpressure", { timeout: 5_000 }, async (t) => {
  let now = 0
  let reads = 0
  t.mock.method(performance, "now", () => now)
  const deadline = bootstrapDeadline(2_000, "Original total expired")
  const iterator = downloadChunksOverHttps(start, { maximumBytes: 8, inactivityTimeoutMs: 100, deadline,
    fetch: async () => new Response(new ReadableStream({
      pull(controller) {
        now += 80
        if (++reads < 4) controller.enqueue(new Uint8Array([reads]))
        else controller.close()
      },
    }, { highWaterMark: 0 })),
  })
  try {
    for (const expected of [1, 2, 3]) {
      assert.deepEqual((await iterator.next()).value, new Uint8Array([expected]))
      now += 500 // Time spent by the disk consumer, not a new network wait.
    }
    assert.equal((await iterator.next()).done, true)
    assert.equal(getEventListeners(deadline.signal, "abort").length, 0)
  } finally { deadline.clear() }
})

test("the original total still aborts fetch while the consumer pauses", { timeout: 5_000 }, async (t) => {
  let now = 0
  let signal
  let cancelled = 0
  t.mock.method(performance, "now", () => now)
  const deadline = bootstrapDeadline(1_000, "Original total expired")
  const iterator = downloadChunksOverHttps(start, { maximumBytes: 8, inactivityTimeoutMs: 100, deadline,
    fetch: async (_url, options) => {
      signal = options.signal
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array([1])) },
        cancel() { cancelled += 1 },
      }, { highWaterMark: 0 }))
    },
  })
  try {
    assert.equal((await iterator.next()).done, false)
    now = 1_000
    assert.throws(() => deadline.check(), /Original total expired/)
    assert.equal(signal.aborted, true, "the total must reach fetch even when no inactivity phase runs")
    assert.equal(cancelled, 1)
    await assert.rejects(iterator.next(), /Original total expired/)
    assert.equal(getEventListeners(deadline.signal, "abort").length, 0)
  } finally { deadline.clear() }
})

test("finishing or abandoning a download clears inactivity timers and parent listeners", { timeout: 5_000 }, async (t) => {
  const pending = new Set()
  const schedule = globalThis.setTimeout
  const clear = globalThis.clearTimeout
  const deadline = bootstrapDeadline(1_000, "Original total expired")
  t.mock.method(globalThis, "setTimeout", (...args) => { const timer = schedule(...args); pending.add(timer); return timer })
  t.mock.method(globalThis, "clearTimeout", (timer) => { pending.delete(timer); return clear(timer) })
  try {
    for (const abandon of [true, false]) {
      const iterator = downloadChunksOverHttps(start, { maximumBytes: 8, inactivityTimeoutMs: 100, deadline,
        fetch: async () => new Response(new Uint8Array([1])),
      })
      assert.equal((await iterator.next()).done, false)
      if (abandon) await iterator.return()
      else assert.equal((await iterator.next()).done, true)
      assert.equal(pending.size, 0)
      assert.equal(getEventListeners(deadline.signal, "abort").length, 0)
    }
  } finally { deadline.clear() }
})

for (const inactivityTimeoutMs of [0, -1, Infinity, NaN, 0.5, 2_147_483_648, null, "100"]) {
  test(`refuses invalid inactivity before fetch: ${inactivityTimeoutMs}`, { timeout: 5_000 }, async () => {
    await assert.rejects(downloadOverHttps(start, { maximumBytes: 8, inactivityTimeoutMs,
      fetch: async () => assert.fail("Invalid inactivity must not create a request"),
    }), /timeout must be a positive integer/)
  })
}
