import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"

import { bootstrapDaemon } from "../bootstrap-daemon.mjs"

// A separate process keeps Buffer allocation accounting independent of other
// tests. Measure reachable backing stores after GC, not machine-dependent RSS.
const chunkBytes = 1024 * 1024
const count = 64
const version = "0.1.0"
const archive = `getdomovoi-daemon-${version}.tgz`
const hash = createHash("sha256")
const hashInput = new Uint8Array(chunkBytes)
for (let index = 0; index < count; index += 1) hash.update(hashInput.fill(index))
const expectedSha256 = hash.digest("hex")
global.gc()
const baseline = process.memoryUsage().arrayBuffers
let maxBufferGrowthBytes = 0
function sample() {
  global.gc()
  maxBufferGrowthBytes = Math.max(maxBufferGrowthBytes, process.memoryUsage().arrayBuffers - baseline)
}
// Observe the final staging-to-publication seam as well as each network pull,
// so collecting a second full buffer after EOF cannot evade the measurement.
// Post-publication verification has its own bounded 64 KiB reader; sampling its
// discarded buffers would measure V8's backing-store reclamation timing instead.
const link = fs.link
fs.link = async (...args) => { sample(); return link(...args) }
syncBuiltinESMExports()
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
console.log(JSON.stringify({ archiveBytes: (await fs.stat(result.path)).size, maxBufferGrowthBytes }))
