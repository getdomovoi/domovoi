import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"

import { bootstrapDaemon } from "../bootstrap-daemon.mjs"

// A separate process keeps Buffer allocation accounting independent of other
// tests. Measure reachable backing stores after GC, not machine-dependent RSS.
const chunkBytes = 1024 * 1024
const count = 64
const version = "0.1.0"
const archive = `getdomovoi-daemon-${version}.tgz`
const hash = createHash("sha256")
for (let index = 0; index < count; index += 1) hash.update(new Uint8Array(chunkBytes).fill(index))
const expectedSha256 = hash.digest("hex")
global.gc()
const baseline = process.memoryUsage().arrayBuffers
let maxBufferGrowthBytes = 0
function sample() {
  global.gc()
  maxBufferGrowthBytes = Math.max(maxBufferGrowthBytes, process.memoryUsage().arrayBuffers - baseline)
}
let produced = 0
const body = new ReadableStream({
  pull(controller) {
    sample()
    if (produced === count) { controller.close(); return }
    controller.enqueue(new Uint8Array(chunkBytes).fill(produced))
    produced += 1
  },
}, { highWaterMark: 0 })
globalThis.fetch = async (url) => new Response(url.endsWith("SHA256SUMS") ? `${expectedSha256}  ${archive}\n` : body)
const result = await bootstrapDaemon({
  version, baseUrl: "https://releases.test", destination: process.argv[2], expectedSha256,
  timeoutMs: 20_000,
})
sample()
console.log(JSON.stringify({ archiveBytes: (await stat(result.path)).size, maxBufferGrowthBytes }))
