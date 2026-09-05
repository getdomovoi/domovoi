import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { prepareDaemonRuntime } from "./prepare-daemon-runtime.mjs"

const testTimeout = 30_000

async function stagingRoot(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "domovoi-runtime-pack-test-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test("removes packaging staging after the packaging deadline expires", { timeout: testTimeout }, async (t) => {
  const root = await stagingRoot(t)
  let now = 0
  t.mock.method(performance, "now", () => now)
  const pack = async (_selector, destination) => { now = 1_000; return join(destination, "never-read.tgz") }
  await assert.rejects(prepareDaemonRuntime({ timeoutMs: 1_000, stagingRoot: root, pack }), /packaging exceeded 1000 ms/)
  assert.deepEqual(await fs.readdir(root), [], "an expired packaging run must not leave its mkdtemp directory")
})

test("reports both the packaging failure and a cleanup that exceeds its own bound", { timeout: testTimeout }, async (t) => {
  const root = await stagingRoot(t)
  const pack = async () => { throw new Error("pack fixture failed") }
  const started = performance.now()
  await assert.rejects(prepareDaemonRuntime({ stagingRoot: root, pack, remove: () => new Promise(() => {}), cleanupTimeoutMs: 200 }), (error) => {
    assert.ok(error instanceof AggregateError, "cleanup failure must not replace the packaging failure")
    assert.match(error.errors[0].message, /pack fixture failed/)
    assert.match(error.errors[1].message, /200 ms/)
    assert.match(error.message, /pack fixture failed.*domovoi-runtime-pack-/)
    return true
  })
  assert.ok(performance.now() - started < 5_000, "the run must end within the cleanup bound")
})
