# Relay crypto measurements on Node 22

Status, 2026-09-07 local time: measured on one Intel Linux development machine.
This supplies daemon-side evidence for the [suite options in #338](https://github.com/getdomovoi/domovoi/pull/338).
It does not select a production suite, establish phone performance or prove
protected key custody. Claude Code owns the phone native-module measurements.

C's full IK exchange was about 1.62 times A's cost on this host. Its AES-GCM
transport path was faster, especially at larger payloads. These observations
support the C recommendation. Subsequent Android hardware evidence below closes
P-256 custody feasibility on the tested handset; phone performance, iOS and Noise
review remain separate gates. These timings are not evidence that C is universally faster or the right
production choice. Fetzy still owns that choice.

## Measured comparison

A is `Noise_IK_25519_ChaChaPoly_SHA256`; C is
`Noise_IK_P256_AESGCM_SHA256` using the Snow 0.10 uncompressed P-256 profile.
Both rows use Node/OpenSSL primitives and the same experimental Node state-machine
structure. This isolates the suite comparison from a JavaScript-versus-native
provider change. It is not a speed comparison against #337's noble implementation.
The new backend stays beside that spike in `packages/protocol/experimental/relay`.

Values below are medians of 15 batch means, in microseconds per operation. The
parenthesized value is the nearest-rank p95 of those batch means, not the p95 of
individual requests. At 15 batches that percentile is the largest batch mean.

| Operation | A: X25519 + ChaChaPoly | C: P-256 + AES-256-GCM |
| --- | ---: | ---: |
| Native private-key generation | 28.56 (31.23) | 26.97 (35.38) |
| One ECDH, preloaded native keys | 26.10 (37.78) | 81.86 (104.28) |
| Complete IK, both endpoints | 1,237.13 (1,464.17) | 2,006.21 (2,436.09) |
| Daemon responder portion of IK | 487.56 (696.82) | 924.96 (1,199.92) |
| AEAD seal + open, 1,024-byte payload | 5.95 (6.66) | 5.25 (6.03) |
| Established channel seal + open, 64 bytes | 4.86 (5.05) | 4.56 (7.92) |
| Established channel seal + open, 1,024 bytes | 6.12 (8.81) | 5.43 (6.05) |
| Established channel seal + open, 16,384 bytes | 35.63 (42.65) | 34.25 (42.54) |
| Established channel seal + open, 65,519 bytes | 85.53 (91.88) | 51.48 (62.91) |

Both suites use the same measured Node SHA-256 and HMAC-SHA-256 implementations.
Hashing 1,024 bytes took **1.04 us** median (1.20 us batch p95); HMAC over 1,024 bytes
with a 32-byte key took **1.86 us** (2.08 us). The HMAC microbenchmark includes
allocating its zero-filled fixture key. Full IK timings include the actual Noise
SHA-256/HMAC schedule, DH operations, framing and authentication tags.

At 65,519 payload bytes, seal plus open corresponds to 730.6 MiB/s for A and
1213.8 MiB/s for C, counting the payload once. These are local memory/crypto rates,
not network or application throughput. AES acceleration, hybrid CPU scheduling,
allocation and garbage collection can all affect this machine's comparison.

| Cost outside those timings | A | C |
| --- | --- | --- |
| Empty-payload IK bytes, first + reply | 96 + 48 = 144 | 162 + 81 = 243 |
| Responder public key | 32 bytes | 65 bytes, uncompressed SEC1 |
| Extra native crypto dependencies, source/manifest inspection | None | None |
| Existing Node executable on this host | 120,078,896 bytes | Same executable |
| Protected key-service call latency | Unmeasured | Unmeasured |
| Phone native-module binary delta and battery cost | Unmeasured | Unmeasured |

The executable is about 114.5 MiB; this is the complete existing Node binary, not
the isolated size of its crypto code or a mobile download delta. This build reports
`node_shared_openssl: false`. Source and manifest inspection establish that the
experiment adds no native crypto dependency; this is not a runtime module census.
Replacing the experimental state machine with a Rust/Noise binding would
have a different, still unmeasured packaging cost. The native primitives follow
the [Node 22 crypto API](https://nodejs.org/docs/latest-v22.x/api/crypto.html).

## Scope and method

The run used Node **22.13.0**, OpenSSL **3.0.15+quic**, V8
**12.4.254.21-node.22**, Linux x64 kernel **7.2.2-1-cachyos**, and an
**Intel Core Ultra 7 165H** with 22 logical CPUs available. It ran on 2026-09-08
03:22 UTC (September 7 locally). The one-minute load average was 1.23 at the start
and 1.29 at the end. This is a shared development host, without CPU affinity or
exclusive frequency/power control. The raw result records all three load averages,
runtime versions, source digests, exact counts and every batch mean.

Three warmup batches precede 15 recorded batches. The order alternates A/C for
each metric and batch. There are 25 handshakes or responder slices per batch,
100 key generations/DH calls, 250 seal/open operations per payload size, and 1,000
hash/HMAC operations. No other Codex test or build ran alongside the measurement.
This short run characterizes this implementation on this host; it is not a
statistical population estimate, a service capacity test or an end-to-end latency
guarantee. The tail values expose the variability rather than hiding it.

An [earlier run](../packages/protocol/experimental/relay/measurements/node22-linux-x64-initial.json)
on this same host measured full IK at 1.49 ms for A and 2.75 ms for C, versus
1.24 ms and 2.01 ms in the tabulated run. The crypto and harness
source digests match between runs; only case-label/comment clarification changed
the shared case file. Keep both observations: host scheduling/load and runtime
variation materially affect these short measurements. They support a relative
tradeoff here, not a fixed production latency budget.

Full IK measures both peers in one process, including fresh native ephemeral
generation for both, public-key encoding/import, four ECDH operations per peer,
two-way handshake framing and transcript comparison. Native static keys are
created once and reused as `KeyObject`s, as a daemon would cache its static handle.
Both handshake payloads are empty. WSS/TLS, relay RTT, bearer admission, sockets,
disk access, initial provisioning and key-service IPC are excluded.

The daemon slice starts just before constructing the responder, includes its
ephemeral generation, first-message processing and reply creation, and ends
before the initiator reads the reply. Each slice has its own timer; their batch
mean excludes client setup and the subsequent transcript check. The isolated
ECDH row excludes public-key import; the full handshake includes it.

Transport timings use established peers, fresh session keys per measurement
workload, and monotonically increasing implicit counters. Every operation seals
and opens one payload, alternating direction. Channel setup is outside that
timer. The AEAD-only row includes cipher construction, nonce formatting, tag
handling and output allocation; the channel row adds its state/bounds checks.

The [raw samples](../packages/protocol/experimental/relay/measurements/node22-linux-x64.json)
were generated by [node-benchmark.ts at 23837ee](https://github.com/getdomovoi/domovoi/blob/23837ee751306a8ee7ffde265e0116cf6d12e78f/packages/protocol/experimental/relay/node-benchmark.ts).
Review subsequently removed a hardcoded addon-list field from the tool and both
artifacts. Timing samples and measured source digests are unchanged; the tabulated
run's digests refer to that commit. The current
[benchmark tool](../packages/protocol/experimental/relay/node-benchmark.ts) omits
that unmeasured field.
From the repository root, with `node` explicitly resolving to Node 22:

```sh
node --version
node --import ./apps/daemon/node_modules/tsx/dist/loader.mjs \
  packages/protocol/experimental/relay/node-benchmark.ts > /tmp/relay-node-benchmark.json
pnpm exec tsc -p packages/protocol/experimental/relay/tsconfig.node.json
```

The tool refuses another Node major, takes no arguments, runs bounded workloads,
and refuses to print timings unless all shared fixture/rejection cases pass.
Keep local reruns separate from the recorded artifact when comparing machines.
No timing thresholds or Python installation enter the normal test suite.

## Correctness and evidence limits

The daemon tests check both published Cacophony A and B vectors, and locally
derived C vectors. Each fixture contains two handshake frames, four transport
frames and the final transcript hash. A/B come unchanged from commit
`8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247`; the full upstream file's SHA-256 is
`3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae`.
Each JSON header retains that provenance.

Cacophony publishes no P-256 vector for this extension. A separate Python model
using cryptography 50.0.1 first reproduces the published A and B expected bytes,
then derives C using the same fixture inputs and the pinned
[Snow P-256 encoding](https://github.com/mcginty/snow/blob/4bb43f50370bdb3e8b1b57814ac662864db2704f/src/resolvers/default.rs#L264).
The Node composition must match those committed C bytes, including AES-GCM's
big-endian nonce progression. This is agreement between separate compositions,
both using OpenSSL-backed primitive providers. It is not a published Cacophony C
vector, an independent primitive-provider proof, or a run against Snow itself.
P-256 remains an extension to [Noise revision 34](https://noiseprotocol.org/noise.html).

The new suite includes malformed/incorrect pins, native key-type refusals, fresh
native-key handshakes, maximum frames, 64-bit nonce progression/exhaustion,
tampering, replay, reordering, truncation and terminal stream refusal. It remains
experimental and unaudited. Node `KeyObject`s here are exportable software keys;
dropping references does not establish immediate erasure or non-exportability.
No production schema, export, relay socket or admission behavior changes.

The original twelve noble cases still prove **one codec, two Node runners,
identical vectors**. Nothing here executes the phone's native bridge or Hermes.

Separate [phone evidence recorded by Claude Code](https://github.com/getdomovoi/domovoi/commit/ea75620)
now proves Android P-256 key custody through two app-UI runs on a Pixel 10 running GrapheneOS,
API 37. AndroidKeyStore reports `strongbox`; the probe gets a 65-byte public point, reopens the
same key alias, agrees on the same 32-byte secret as a fresh software peer, and deletes the key.
Static private material stays in the key service. An API 36 emulator passes and reports `software`.
The hardware probe uses platform entropy explicitly after noble's ambient generator failed
because Hermes lacked `crypto.getRandomValues`.

This increases confidence in the unchanged option C recommendation. It does not turn the Node
timings into phone measurements or the twelve shared fixtures into Hermes runs. iOS Secure Enclave,
complete phone Noise execution, broader device/custody policy, native binary size, key-service
latency, battery cost and the reviewed production integration remain open. Android API 31 is the
proposed floor, with no assumption that every supported device provides StrongBox.
