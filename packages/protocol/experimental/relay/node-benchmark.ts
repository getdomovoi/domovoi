// Run explicitly with Node 22. This measures one host, not a phone or key service.
import { Buffer } from "node:buffer"
import { createPublicKey, diffieHellman } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { availableParallelism, cpus, loadavg, release } from "node:os"
import { performance } from "node:perf_hooks"
import fixture from "./cacophony-ik.json"
import aesFixture from "./cacophony-ik-aesgcm.json"
import p256Fixture from "./cacophony-derived-p256.json"
import { createNodeNoiseIk } from "./node-noise-ik"
import { generatePrivateKey, hmac, nodeSuite, nodeSuites, NodeCipherState, publicBytes, sha256 } from "./node-primitives"
import type { NodeSuite } from "./node-primitives"
import { createRelayVectorCases } from "./vector-cases"

if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Use Node 22 explicitly for this comparison")
if (process.argv.length !== 2) throw new Error("This bounded benchmark takes no arguments")

// No timings or thresholds enter CI. Each stored sample is a batch mean.
const batches = 15
const warmupBatches = 3
const startedAt = new Date().toISOString()
const startLoad = loadavg()
const empty = new Uint8Array()
let sink = 0
function consume(bytes: Uint8Array): void { sink ^= bytes.length ^ (bytes[0] ?? 0) }
function timeBatch(operation: () => void, count: number): number {
  const start = performance.now()
  for (let index = 0; index < count; index++) operation()
  return (performance.now() - start) * 1000 / count
}

// Refuse to produce numbers if the exact fixtures or rejection cases diverge.
for (const vector of [fixture, aesFixture, p256Fixture]) {
  for (const test of createRelayVectorCases(createNodeNoiseIk, vector, nodeSuites.map((suite) => suite.name))) test.run()
}

type Workload = {
  name: string
  suite: string
  iterations: number
  payloadBytes?: number
  measure: (count: number) => number
  batchMeanMicroseconds: number[]
}
function workload(suite: string, name: string, iterations: number, operation: () => void, payloadBytes?: number): Workload {
  return { suite, name, iterations, measure: (count) => timeBatch(operation, count), batchMeanMicroseconds: [],
    ...(payloadBytes === undefined ? {} : { payloadBytes }) }
}

function workloads(suite: NodeSuite): Workload[] {
  // Static key generation is provisioning cost, outside each IK operation.
  // Ephemeral generation is inside every full handshake and responder slice.
  const clientStatic = generatePrivateKey(suite)
  const serverStatic = generatePrivateKey(suite)
  const responderPublicKey = publicBytes(suite, serverStatic)
  const initiator = () => createNodeNoiseIk({ role: "initiator", suite: suite.name, prologue: empty,
    staticKey: clientStatic, ephemeralKey: generatePrivateKey(suite), responderPublicKey })
  const responder = () => createNodeNoiseIk({ role: "responder", suite: suite.name, prologue: empty,
    staticKey: serverStatic, ephemeralKey: generatePrivateKey(suite) })
  const connected = () => {
    const client = initiator()
    const server = responder()
    server.readHandshake(client.writeHandshake(empty))
    client.readHandshake(server.writeHandshake(empty))
    if (!Buffer.from(client.handshakeHash()).equals(server.handshakeHash())) throw new Error("Handshake hash mismatch")
    return { client, server }
  }
  const peer = createPublicKey(serverStatic)
  const result: Workload[] = [
    workload(suite.name, "private-key-generation", 100, () => {
      // Consume a public property; do not export the generated private key.
      sink ^= generatePrivateKey(suite).asymmetricKeyType?.length ?? 0
    }),
    workload(suite.name, "dh-preloaded-keyobjects", 100, () => consume(diffieHellman({ privateKey: clientStatic, publicKey: peer }))),
    workload(suite.name, "ik-full-pair", 25, () => consume(connected().client.handshakeHash())),
  ]
  result.push({ suite: suite.name, name: "ik-daemon-responder", iterations: 25, batchMeanMicroseconds: [],
    measure(count) {
      let microseconds = 0
      for (let index = 0; index < count; index++) {
        const client = initiator()
        const first = client.writeHandshake(empty)
        const start = performance.now()
        const server = responder()
        server.readHandshake(first)
        const reply = server.writeHandshake(empty)
        microseconds += (performance.now() - start) * 1000
        client.readHandshake(reply)
        if (!Buffer.from(client.handshakeHash()).equals(server.handshakeHash())) throw new Error("Handshake hash mismatch")
        consume(reply)
      }
      return microseconds / count
    },
  })
  for (const size of [64, 1024, 16384, 65519]) {
    const { client, server } = connected()
    const payload = new Uint8Array(size).fill(173)
    let reverse = false
    result.push(workload(suite.name, "transport-seal-open", 250, () => {
      reverse = !reverse
      const [sender, receiver] = reverse ? [server, client] : [client, server]
      consume(receiver.decrypt(sender.encrypt(payload)))
    }, size))
  }
  // Isolate AEAD construction + seal/open + Noise nonce formatting at 1 KiB.
  // Counters remain monotonic and separate from the transport measurements.
  const key = new Uint8Array(32).fill(42)
  const sender = new NodeCipherState(suite, key)
  const receiver = new NodeCipherState(suite, key)
  const payload = new Uint8Array(1024).fill(173)
  result.push(workload(suite.name, "aead-seal-open", 250,
    () => consume(receiver.crypt(sender.crypt(payload, empty, false), empty, true)), payload.length))
  return result
}

const compared = [nodeSuite(fixture.protocol_name), nodeSuite(p256Fixture.protocol_name)]
const groups = compared.map(workloads)
const payload = new Uint8Array(1024).fill(173)
const common = [
  workload("common", "sha256", 1000, () => consume(sha256(payload)), payload.length),
  workload("common", "hmac-sha256", 1000, () => consume(hmac(new Uint8Array(32), payload)), payload.length),
]
for (let batch = -warmupBatches; batch < batches; batch++) {
  // Pair each metric and alternate A/C ordering to reduce order bias.
  for (let index = 0; index < groups[0]!.length; index++) {
    const order = batch % 2 === 0 ? groups : [...groups].reverse()
    for (const group of order) {
      const item = group[index]!
      const value = item.measure(item.iterations)
      if (batch >= 0) item.batchMeanMicroseconds.push(value)
    }
  }
  for (const item of common) {
    const value = item.measure(item.iterations)
    if (batch >= 0) item.batchMeanMicroseconds.push(value)
  }
}

const files = ["node-benchmark.ts", "node-noise-ik.ts", "node-primitives.ts", "vector-cases.ts",
  "noise-ik.ts", "cacophony-ik.json", "cacophony-ik-aesgcm.json", "cacophony-derived-p256.json", "derive-p256-fixture.py"]
const output = {
  format: 1,
  startedAt, finishedAt: new Date().toISOString(),
  environment: {
    node: process.versions.node, openssl: process.versions.openssl, v8: process.versions.v8,
    platform: process.platform, arch: process.arch, kernel: release(),
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, availableParallelism: availableParallelism(),
    loadAverageStart: startLoad, loadAverageEnd: loadavg(),
    nodeExecutableBytes: statSync(process.execPath).size,
    nodeSharedOpenSsl: process.config.variables["node_shared_openssl"],
  },
  sources: Object.fromEntries(files.map((file) => [file, Buffer.from(sha256(readFileSync(new URL(file, import.meta.url)))).toString("hex")])),
  methodology: {
    batches, warmupBatches, unit: "microseconds per operation",
    summary: "median and nearest-rank p95 of batch means, not individual-operation percentiles",
    fullIk: "Both endpoints, fresh native ephemerals, cached native statics, empty handshake payloads, transcript check; no network or admission",
    responder: "Sum of timed responder creation (including ephemeral generation), first read and reply write; initiator work and transcript check excluded",
    transport: "Established connection; one seal plus one open, alternating direction, implicit monotonic nonces; setup excluded",
    dh: "One diffieHellman with both KeyObjects already loaded; peer import excluded",
    throughput: "Payload counted once per seal/open operation; not network throughput",
    limits: "One shared host, no CPU affinity; no phone, native protected key service, battery measurement or formal Noise review",
  },
  results: [...groups.flat(), ...common].map(({ measure: _measure, ...item }) => {
    const sorted = [...item.batchMeanMicroseconds].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    return { ...item, medianMicroseconds: median, p95BatchMeanMicroseconds: sorted[Math.ceil(0.95 * sorted.length) - 1]!,
      ...(item.payloadBytes === undefined ? {} : { payloadMiBPerSecond: item.payloadBytes / (median / 1e6) / 2 ** 20 }) }
  }),
  sink,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
