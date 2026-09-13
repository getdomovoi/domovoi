# Relay crypto spike

Historical evidence and options. The 2026-09-12 decision supersedes the suite,
custody and implementation recommendations below: suite A, the noble composition.
See [the frozen codec contract](relay-wire-format.md) for the current decision
and remaining integration limits. Commands and source paths below describe the
pre-freeze experiment, preserved at [5211e818](https://github.com/getdomovoi/domovoi/tree/5211e81826b29601bd61b210693113c9a394ea04/packages/protocol/experimental/relay).

Status, 2026-09-07: one experimental codec, two runners, identical published
vectors. The suite and public-key shape remain unresolved in production protocol.
The production route schema remains gated on that decision. The RPC/terminal
capability policy is independent of it; the [route decision](encrypted-relay.md#public-route-descriptor)
explains why a capability list alone does not complete the descriptor contract.

## Reproduced evidence

The shared fixtures and assertions live in
`packages/protocol/experimental/relay`. The daemon's Vitest suite and the phone's
jest-expo suite execute the same twelve cases. Both run under Node. jest-expo
additionally exercises the phone's Babel transform and module environment; it
does not execute Hermes, native entropy, or native key storage.

The candidate is `Noise_IK_25519_ChaChaPoly_SHA256`. A complete, published
Cacophony vector provides two handshake ciphertexts, four transport ciphertexts
with alternating directions and increasing nonces, and the final handshake hash.
Fixture provenance, immutable source revision, digest, and license are in the
[fixture README](https://github.com/getdomovoi/domovoi/blob/5211e81826b29601bd61b210693113c9a394ea04/packages/protocol/experimental/relay/README.md).

The shared cases also check:

- altered prologue and responder pin, unsupported suites, malformed keys, and
  low-order public keys;
- corruption of both handshake messages, ciphertext tampering, truncation,
  replay, reordering, and ciphertext from a different handshake;
- terminal rejection of both stream directions after a failure, handshake order,
  and the Noise 65,535-byte frame bound;
- caller-owned key copies and operation without Buffer, text encoders, or a
  `Math.random` fallback;
- synthetic bearer, JSON-RPC, terminal, and error payloads appearing only inside
  ciphertext outputs, with private fixture keys absent from those outputs.

The daemon runner additionally tests real Node Buffer input ownership. Buffer's
`slice()` shares memory, unlike Uint8Array's; the codec copies constructor inputs
and retained packet fields explicitly.

These are codec-boundary checks. There is no relay socket, logging pipeline,
paired-device admission, bearer rotation, revocation, or production reconnect in
this experiment. They do not prove those future boundaries preserve confidentiality.

TDD first produced identical expected-byte failures in both runners. The vectors
then caught hashing the 32-byte protocol name instead of using it verbatim. The
negative cases caught accepting an alternate suite, exposing primitive errors,
and accepting a valid frame after a failed one. The Buffer regression failed on
shared key views before those inputs were copied.

## Running it

From the repository root:

```sh
pnpm --filter @getdomovoi/daemon exec vitest run src/relay-crypto-vectors.test.ts --coverage.enabled=false
pnpm --filter @getdomovoi/mobile exec jest --runInBand src/relay-crypto-vectors.test.tsx
```

Both suites also run through the normal sequential `pnpm test` command.

The existing Expo/Metro toolchain and installed hermesc compiler can compile the
same cases as a separate native-build entry, without modifying the phone app:

```sh
pnpm --filter @getdomovoi/mobile exec expo export:embed --entry-file ../../packages/protocol/experimental/relay/vector-entry.ts --platform ios --bundle-output /tmp/domovoi-relay-ios.hbc --dev false --minify false --max-workers 2 --bytecode
```

This succeeded with 23 modules and Hermes bytecode version 98, using the locked
`hermes-compiler@250829098.0.17`. Compilation proves module resolution and compiler
acceptance. It does not execute the result. Executing these twelve full-codec
cases under Hermes remains open. No Hermes engine source or prebuilt VM was downloaded.

## Subsequent Android hardware evidence

The [phone P-256 probe](https://github.com/getdomovoi/domovoi/commit/ea75620) is separate from this
X25519 codec. Claude Code reported two successful app-UI runs on a Pixel 10 with GrapheneOS,
Android API 37: platform entropy, fresh software P-256 peer generation, a 65-byte static public
point, a native key alias that reopens to the same point, a matching 32-byte ECDH secret, and
deletion. The static private key remains in AndroidKeyStore; the reported security level was
`strongbox`. An API 36 emulator passes the same steps and reports `software`.

That proves the observed Android P-256 custody path. It also exposed a real Hermes requirement:
noble's ambient key generator threw `crypto.getRandomValues must be defined`. The probe now
obtains scalar bytes from the platform random service. A production phone codec needs explicit
native entropy; these deterministic fixtures supply keys and cannot detect that missing service.

The [suite recommendation in #338](https://github.com/getdomovoi/domovoi/pull/338) remains P-256
with AES-GCM, with higher confidence from this hardware result. It does not establish protected
X25519 operations for this spike's candidate, complete Noise execution on a phone, or an iOS
Secure Enclave result. Android API 31 remains the proposed floor; StrongBox is not universal and
the supported-device policy still needs a decision.

## Dependency evidence and limits

The experiment pins `@noble/curves`, `@noble/ciphers`, and `@noble/hashes` to 2.4.0
as development dependencies. Registry resolution and lockfile integrity identify
the tested versions; this does not establish an audit of those exact versions.

The [Cure53 September 2024 report](https://cure53.de/audit-report_noble-crypto-libs.pdf)
was read directly. Its scope names curves 1.5.0 and ciphers 0.6.0, including the
Montgomery primitives and all cipher modules. Current READMEs associate that
assessment with curves 1.6.0 and ciphers 1.0.0. The report also discusses BigInt
timing and the limits of wiping memory in JavaScript. It covers neither this
Noise composition nor a phone runtime.

The [Cure53 January 2022 report](https://cure53.de/pentest-report_hashing-libs.pdf)
covers the hashing library and related projects; blake3 and sha3-addons were
excluded. SHA-256 and HMAC fall within its stated hashing scope. This is historical
audit evidence, not an audit of hashes 2.4.0.

The [current curves README](https://github.com/paulmillr/noble-curves#security)
also claims an August 2026 Trail of Bits assessment of 2.3.0. The checked audit
directory contains the 2023 and 2024 reports but no corresponding 2026 report, so
that newer claim was not independently verified here. The three repositories
remain maintained and have published 2.4.0, but publication and maintainer
self-audits do not substitute for independent review.

## Decision before a production contract

Do not promote this composition or freeze its suite/key fields yet:

1. A maintained, independently reviewed Noise integration still needs selection.
   [noise-handshake 4.2.0](https://github.com/holepunchto/noise-handshake) supports
   IK but its symmetric state fixes BLAKE2b, and its cipher source encodes only
   the low 32 nonce bits. It is not a drop-in implementation of this candidate.
   [ChainSafe's Noise integration](https://github.com/ChainSafe/js-libp2p-noise)
   targets libp2p and exposes libp2p connection/admission interfaces. No suitable
   audited standalone IK layer was established in this comparison. Maintaining
   our own handshake composition in production requires an explicit review and
   maintenance decision; this spike does not make that decision.
2. Wire explicit native entropy into the production codec. Android entropy and P-256 static-key
   operations are proven separately above; this experiment still takes fixture keys and performs
   no real key generation. Its X25519 candidate has no demonstrated protected-handle path.
   Noble can also use an RNG detected at module initialization for multiplication blinding.
   Account for that dependency without an ambient WebCrypto assumption or an insecure fallback.
3. [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)
   stores and returns strings. The current phone credential adapter provides no
   key-agreement operation using a non-exportable key handle. The separate native P-256 module
   supplies that operation on the tested Android device. Passing a private key string into this
   codec would still violate the static-key custody requirement. iOS proof, app relaunch, backup
   exclusion, key-loss refusal, and a supported-device policy remain integration gates.
4. Real Hermes execution of the full Noise codec remains an explicit evidence limit. The P-256
   hardware probe exercises native agreement and software-peer arithmetic in Hermes, not these
   twelve handshake/transport cases. The two Node runners and bytecode compilation still do not
   establish full-codec engine agreement or side-channel properties.

The experiment is outside production exports, runtime dependencies, and published
protocol files. No production relay schema, daemon manager, or relay server is
introduced. The commercial-server boundary in `docs/encrypted-relay.md` is unchanged.
