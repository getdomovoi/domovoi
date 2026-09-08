# Experimental relay vectors

This directory is test tooling. It has no production export and is outside the
protocol package's `dist` build and published files. The noble packages are exact
development dependencies. Do not import this codec from production code.

`cacophony-ik.json` contains the complete vector selected by
`protocol_name == "Noise_IK_25519_ChaChaPoly_SHA256"` from
[Cacophony's published vectors at 8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247](https://github.com/centromere/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/vectors/cacophony.txt).
The full upstream source file has SHA-256
`3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae`.
The `_source` header records that immutable revision and the full source digest
inside the fixture. Excluding this added metadata, the selection was compared
structurally against that source. Object key order and whitespace differ; all
upstream field values are unchanged. Its upstream license is
the [Unlicense](https://github.com/centromere/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/LICENSE).
These published private keys are public fixtures. Never use them for a connection.

`noise-ik.ts` implements only the candidate IK pattern from
[Noise revision 34](https://noiseprotocol.org/noise.html), using noble primitives.
It is an unaudited composition for this experiment. `vector-cases.ts` holds the
shared assertions; neither runner mocks the primitives or generates the expected
bytes. `vector-entry.ts` is an optional Metro/hermesc compilation entry.

See [the evidence and remaining gates](../../../../docs/relay-crypto-spike.md)
before making any production crypto or schema decision.

## Node 22 comparison

`node-noise-ik.ts` is a second experimental state machine using `node:crypto` for
all primitives. It accepts public fixture scalars or exportable Node `KeyObject`s.
It adds no native package and does not supply protected key custody. It supports
A (X25519/ChaChaPoly), B (X25519/AESGCM, for correctness), and C (P-256/AESGCM,
Snow 0.10's uncompressed extension profile). SHA-256 and HMAC also use Node.
The shared case factory preserves the original twelve noble cases for jest-expo.
The new backend runs only in the daemon suite; it makes no new phone-runtime claim.

`cacophony-ik-aesgcm.json` is the unchanged B selection from the same pinned source
and carries its commit and full-file SHA-256 header. Cacophony does not publish
the P-256 extension vector. `cacophony-derived-p256.json` reuses its public fixture
inputs, interprets the private bytes as big-endian P-256 scalars, and replaces the
responder point, ciphertexts and transcript hash. Its header distinguishes those
locally derived outputs from published vectors and pins the Snow reference commit.

`derive-p256-fixture.py` is a separate Python transcript model using cryptography
50.0.1. It must reproduce both published A and B vectors before checking or writing
C. Run `python3 packages/protocol/experimental/relay/derive-p256-fixture.py` to check;
add `--write` to regenerate. This optional maintenance tool is not a CI dependency.
The Node tests load the committed expected bytes. Two independent compositions
with crypto providers backed by OpenSSL are useful agreement evidence, not a
formal review or execution against Snow or a protected phone key handle.

The [measurement report](../../../../docs/relay-node-benchmarks.md) gives the exact
command, raw samples, host details and limits. `node-benchmark.ts` refuses a Node
major other than 22 and checks the fixtures before measuring. No timing threshold
enters CI. The Node tooling can be checked separately with
`pnpm exec tsc -p packages/protocol/experimental/relay/tsconfig.node.json`.
