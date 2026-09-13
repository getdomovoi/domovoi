# Production relay Noise suite options

Historical evidence and options. The 2026-09-12 decision supersedes the suite,
custody and implementation recommendations below: suite A, the noble composition.
See [the frozen codec contract](relay-wire-format.md) for the current decision
and remaining integration limits. Commands and source paths below describe the
pre-freeze experiment, preserved at [5211e818](https://github.com/getdomovoi/domovoi/tree/5211e81826b29601bd61b210693113c9a394ea04/packages/protocol/experimental/relay).

Status, 2026-09-07: updated with reported Android hardware evidence, awaiting fetzy's decision.
This is an options document, not a production suite selection or protocol schema.

**Recommendation:** choose `Noise_IK_P256_AESGCM_SHA256`, with the P-256 wire profile used by
Snow 0.10.0, subject to the remaining integration, iOS, and review gates below. Android private-key
operations inside the platform key service are now demonstrated on a Pixel 10 reporting StrongBox.
That increases confidence in C; it does not change the recommended suite. Its price is an extension to official
Noise, larger public keys, native integration, and an explicit review commitment. This is a
recommendation, not approval to freeze the suite or adopt Snow unchanged.

Claude Code owns the native phone spike. Codex owns this comparison and the subsequent production
Noise integration proposal. The outbound manager, fake relay, and production route schema remain
deferred. The [commercial-server boundary](encrypted-relay.md#open-core-and-trust-boundaries)
is unchanged.

## Requirements that drive the choice

The [agreed relay design](encrypted-relay.md) requires direct pairing to pin the daemon's static
channel public key and bind a device's public key to its active bearer record. Relay ingress must
require both device factors. The phone's private channel key must be generated and used through
the platform key service, be device-only, and support forgetting and key-loss refusal. RPC and
terminal traffic are in scope; preview bytes remain a separate transport gate.

Keychain storage and protected key operations are different mechanisms. Apple documents ordinary
keychain use as copying plaintext key material into application memory, while its Secure Enclave
interface performs operations without exporting that material and supports P-256 ECDH. A Swift
wrapper that hides an exported X25519 scalar from JavaScript would narrow exposure, but would not
establish the same platform operation boundary. Accepting that weaker boundary would change the
current design and requires fetzy's explicit decision.
[Apple's key protection model](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave?changes=_7)
and [CryptoKit key storage](https://developer.apple.com/documentation/cryptokit/storing-cryptokit-keys-in-the-keychain?changes=_7)
describe the distinction.

## Candidate suites and wire cost

All three options use IK because direct pairing already supplies the responder pin. The comparison
assumes empty handshake payloads and a separate encrypted admission record after the handshake.
It excludes WSS/TLS setup, WebSocket framing, relay multiplexing headers, application JSON, and
padding. These are ciphertext byte counts, not base64-encoded frame sizes or measured bandwidth.

| Option | Candidate suite | Responder public key | Unpadded base64url pin | First IK message | Reply | Handshake total | Each transport record |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | `Noise_IK_25519_ChaChaPoly_SHA256` | 32 bytes | 43 characters | 96 bytes | 48 bytes | 144 bytes | Payload + 16 bytes |
| B | `Noise_IK_25519_AESGCM_SHA256` | 32 bytes | 43 characters | 96 bytes | 48 bytes | 144 bytes | Payload + 16 bytes |
| C, recommended | `Noise_IK_P256_AESGCM_SHA256` | 65 bytes | 87 characters | 162 bytes | 81 bytes | 243 bytes | Payload + 16 bytes |

A and B use algorithms specified by [Noise revision 34](https://noiseprotocol.org/noise.html).
C uses Snow's extension: an uncompressed SEC1 P-256 public point and a 32-byte ECDH result.
P-256 is **not** a DH function in official Noise revision 34. The reference is Snow 0.10.0,
commit `4bb43f50370bdb3e8b1b57814ac662864db2704f`, whose
[resolver](https://github.com/mcginty/snow/blob/4bb43f50370bdb3e8b1b57814ac662864db2704f/src/resolvers/default.rs#L264)
separates public-key length from DH-result length. Any eventual profile must specify those rules
explicitly; the suite name alone does not make an extension interoperable.

The size calculation is `2P + 32` for the first message and `P + 16` for the reply, where `P` is
the encoded public-key length. The first message carries an ephemeral key, an encrypted static
key, and an encrypted empty payload. The reply carries an ephemeral key and an encrypted empty
payload. Thus C adds 99 handshake bytes and 44 pin characters over A/B. A serialized admission
payload of `B` bytes adds `B + 16` bytes as a transport record. The route's existing 32-byte opaque
id remains 43 base64url characters for every option; endpoint and JSON field costs are additional.

The A/B arithmetic was checked against both complete suites in
[Cacophony commit 8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247](https://github.com/centromere/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/vectors/cacophony.txt),
subtracting each fixture's plaintext length from its ciphertext length. C's cost is calculated
from the inspected encoding and IK pattern. The subsequent
[Node experiment in #339](https://github.com/getdomovoi/domovoi/pull/339) reproduces locally derived
P-256 IK vectors; it does not execute a complete Noise handshake on the phone.

Noise uses implicit transport counters, so a separate nonce is not included in these counts.
AESGCM means AES-256-GCM with a 16-byte tag and a nonce formed from four zero bytes plus the
64-bit counter in big-endian order; ChaChaPoly uses little-endian counter order.
Neither option permits nonce reuse. The native adapter must use the exact profile nonce and
ciphertext/tag layout. For example, CryptoKit's
[combined AES-GCM representation](https://developer.apple.com/documentation/cryptokit/aes/gcm/sealedbox/combined?changes=_7)
also includes the nonce and cannot be copied verbatim as a Noise record.

## Native dependencies and phone obligations

These are dependency paths to evaluate, not libraries added by this document. The
[Node 22 measurements](https://github.com/getdomovoi/domovoi/blob/44e9e7cdd2da7193bb46fcfcec861f092e6f4e26/docs/relay-node-benchmarks.md)
put a full IK exchange at 1.24 ms for A and 2.01 ms for C on one Intel Linux development machine;
at 65,519 payload bytes, seal plus open took 85.53 us for A and 51.48 us for C. These are daemon-side
software measurements. Phone binary size, complete handshake latency, key-service latency, and
battery cost remain unmeasured. A suite fixes algorithms and encodings, not an implementation package.

| Option | Daemon implementation cost | Phone implementation cost and required proof |
| --- | --- | --- |
| A | Existing Node/OpenSSL primitives or the experimental noble JS primitives can supply X25519, ChaCha20-Poly1305, SHA-256 and HMAC. A production Noise state machine still needs selection and review. No additional native crypto package is inherently required on Node. | Native fresh entropy plus X25519 static-key operations through a non-exportable platform handle. That custody path is unproven. CryptoKit software Curve25519 or a bundled X25519 library supplies arithmetic, not proof of protected custody. A native bridge is still required even if the rest of Noise stays JS. |
| B | Same X25519/hash requirements as A; substitute AES-256-GCM. Node/OpenSSL can supply the primitive without another native package. This does not remove Noise review work. | Same unresolved X25519 custody as A. AES-GCM can use platform providers, but changing the cipher does not give the static X25519 key a protected operation API. Must reproduce the AES nonce/tag layout and SHA-256/HMAC key schedule. |
| C | Node/OpenSSL P-256 ECDH, AES-GCM and SHA-256/HMAC are exercised by #339. Using Snow instead adds a Rust Noise dependency and Node native bindings/builds across supported daemon platforms. Its P-256 profile needs explicit interop review in either implementation. | The Android bridge now demonstrates platform entropy, fresh P-256 peer generation, a 65-byte static public point, a 32-byte ECDH result, and create/reopen/agreement/delete through an opaque key alias. Pixel 10 reports StrongBox; the API 36 emulator reports software. iOS Secure Enclave remains unproven. Full Noise composition, AES-GCM nonce/tag behavior and the SHA-256/HMAC schedule still need phone integration and review. A shared Rust layer would also need phone builds and a resolver adapted to platform handles. |

The daemon primitive claims follow the [Node 22 crypto API](https://nodejs.org/docs/latest-v22.x/api/crypto.html).
The pure JS codec in [#337](https://github.com/getdomovoi/domovoi/pull/337) uses exact noble 2.4.0
development dependencies outside production exports. Its twelve shared cases prove one codec
under two Node runners, including jest-expo. Metro/hermesc compilation proves compiler acceptance.
Neither establishes Hermes execution, native key custody, or an audit of the composition. Its
expected ciphertexts apply to A and do not validate B or C implementations.

The separate Android probe supplies actual Hermes and key-service evidence for P-256. It does
not change what those twelve Node-runner fixtures prove, and it does not run their full IK suite.

For A/B, Android lists general `XDH` support from API 33, but this is not a promise that
`AndroidKeyStore` can generate and use a non-exportable X25519 key. An available software provider
must not be mistaken for the platform key service. Apple's documented Secure Enclave ECDH path
is P-256. These are the reasons A/B remain custody questions despite their lower wire cost.
[Android KeyAgreement algorithms](https://developer.android.com/reference/javax/crypto/KeyAgreement),
[Apple Secure Enclave P-256](https://developer.apple.com/documentation/cryptokit/secureenclave/p256?changes=_2)

For C, Android's `PURPOSE_AGREE_KEY` begins at API 31, and its official example uses `secp256r1`
with the `AndroidKeyStore` provider. The proposed relay path therefore requires that API and
successful key generation/agreement on the device; older or unsupported devices remain direct-only.
Keystore use does not by itself promise StrongBox hardware. The probe reads the actual security
level. Fetzy still needs a supported-device policy covering StrongBox, other hardware backing,
software backing, and unsupported devices; one successful handset does not establish that policy.
[Android key purposes](https://developer.android.com/reference/android/security/keystore/KeyProperties#PURPOSE_AGREE_KEY),
[ECDH example](https://developer.android.com/reference/kotlin/android/security/keystore/KeyGenParameterSpec.html),
[Keystore security levels](https://developer.android.com/privacy-and-security/keystore)

AES-GCM has documented platform entry points in
[CryptoKit](https://developer.apple.com/documentation/cryptokit/aes/gcm?changes=_5) and
[Android Cipher](https://developer.android.com/reference/javax/crypto/Cipher).
The Android ECDH proof does not claim that AES-GCM and its derived session keys execute inside the
hardware protecting the static key. The [bearer credential adapter](../apps/mobile/src/lib/credentials.ts)
still stores and returns strings through [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/).
The new device-key module is a separate operation API for channel keys.

## Observed Android custody and remaining phone evidence

Claude Code reported two successful runs through the app's own UI on a **Pixel 10, GrapheneOS,
Android API 37**. The [phone probe and roadmap record](https://github.com/getdomovoi/domovoi/commit/ea75620)
are separate from Codex's Node measurements. The report contains:

| Check | Observed result |
| --- | --- |
| Platform key service | Key agreement supported |
| System entropy | 32 bytes returned; 30 distinct values in the reported sample |
| Static key creation | 65-byte public point; reported security level `strongbox` |
| Handle reopen | Same public point returned for the stored alias |
| Agreement against a fresh software peer | Both sides produced the same 32-byte ECDH secret |
| Key removal | Probe key deleted |

The native module uses `KeyPairGenerator` in `AndroidKeyStore`, `PURPOSE_AGREE_KEY`, and
`secp256r1`, requesting StrongBox and reading the resulting security level. The static private key
stays inside the key service; the bridge returns an alias, a public point, and agreement results.
The software peer draws its scalar from the platform random-byte API, validates that scalar,
and computes the matching agreement against the platform public point. That establishes fresh
ephemeral peer generation and the static handle's create/reopen/agreement/delete lifecycle on
the tested device. The sample-byte check exercises entropy delivery, not a statistical RNG audit.
An Android API 36 emulator passes the same steps and reports `software`.

The hardware run also exposed a concrete runtime dependency: noble's ambient key generator threw
`crypto.getRandomValues must be defined` under Hermes. The probe now supplies platform entropy
explicitly. Every production phone codec must receive an explicit native entropy source for
fresh keys and account for any primitive's randomness needs, including blinding; ambient WebCrypto
availability cannot be assumed. Static private-key operations must keep using the native handle.

**iOS remains unproven.** The available Intel Mac could not build the Expo SDK 57 / Swift 6.2
probe with its available toolchain, so there is no Secure Enclave execution result. This records
that build-environment limit, not a blanket claim that Xcode 26 requires Apple Silicon: Apple's
[support matrix](https://developer.apple.com/xcode/system-requirements) lists Xcode 26.0 through
26.3 on macOS Sequoia 15.6, and its [Xcode 26 overview](https://developer.apple.com/videos/play/wwdc2025/247/)
describes Intel simulator support as omitted from the default download. A working supported
toolchain and an iOS hardware run are still required.

Android API 31 remains the proposed ECDH floor. The successful Pixel run closes Android P-256
custody feasibility for that configuration; iOS, broader device policy, full phone Noise execution,
and the remaining production lifecycle cases below remain separate gates.

## What the responder pin must carry

The existing logical descriptor needs the exact suite identifier and the full daemon static
public-key encoding, learned over direct pairing and bound to that machine. A fingerprint or key
id alone cannot initialize IK. The device public key stored beside its bearer must use the same
suite's key type; an Ed25519 signing key is not an X25519 or P-256 agreement key.

For A/B, the pin carries the 32-byte X25519 public value defined by
[RFC 7748](https://www.rfc-editor.org/rfc/rfc7748.html#section-5), encoded as canonical unpadded
base64url. For C, it carries the 65-byte uncompressed SEC1 point: `0x04`, a 32-byte big-endian X
coordinate, and a 32-byte big-endian Y coordinate. C must reject infinity, invalid points, and
encodings outside that P-256 profile. A/B must apply the X25519 decoding rules and reject an
all-zero DH result. The suite binding determines how raw bytes are interpreted; length alone
cannot establish a key's type or provenance. Validation and peer-key proof must precede admission.

Using a 33-byte compressed P-256 point would change C's handshake to 98 and 49 bytes, but would be
a different wire profile from the reference above. It must not silently share C's encoding rules.
DER, SPKI, certificates, JSON Web Keys, and platform key handles are also not interchangeable with
the proposed raw pin bytes. The descriptor contains public material only; bearer credentials,
registration secrets, private scalars, and private-key storage blobs remain excluded.

Recommendation for v1: configure one selected suite per paired route, authenticate that choice,
and refuse a mismatch without trying another suite. Changed suite/key bindings require an explicit
direct re-pair. Do not negotiate a downgrade or import a new pin from a hostile relay response.

## Production integration and review cost

Selecting a suite is separate from selecting a reviewed Noise implementation. Snow 0.10.0 is a
concrete reference for all three options, but its
[pinned README](https://github.com/mcginty/snow/blob/4bb43f50370bdb3e8b1b57814ac662864db2704f/README.md)
explicitly says it has had no formal audit. Its default P-256 resolver stores a raw private scalar,
and its [DH trait](https://github.com/mcginty/snow/blob/4bb43f50370bdb3e8b1b57814ac662864db2704f/src/types.rs#L24)
includes private-key setters/getters. Default feature support is not a ready native-handle
integration. A reviewed adapter or interface change would need to preserve the profile while
keeping the phone's private scalar inside its key service. Shipping the JS experiment would
instead commit Domovoi to maintaining and reviewing its own Noise composition.

My recommendation is to keep Snow as the profile and interop reference while evaluating that
adapter cost, not to bless its current source as the production dependency. Fetzy must fund or
otherwise arrange review of the selected exact implementation, its native adapter, and the
Domovoi admission binding. Historical audits of individual primitives do not establish that result.

The remaining phone integration evidence for C, owned by Claude Code, is:

1. Reproduce the Android static-handle and ECDH proof through iOS Secure Enclave. Extend the
   Android create/reopen/agreement/delete result with app relaunch, backup exclusion, and
   key-loss refusal cases. Apple Secure Enclave keys cannot be imported just to fit a
   fixture: deterministic software vectors and a separately generated native-handle interop case
   prove different parts of the boundary.
2. Wire the proven Android native entropy and fresh P-256 peer generation into the full IK
   composition, and establish that path on iOS. IK needs four DH operations per peer,
   including two uses of the static key: the phone uses it against the daemon static pin and the
   daemon's fresh ephemeral key. An ECDSA signing-only handle does not satisfy that requirement.
3. Reproduce the exact public point, raw ECDH result, SHA-256/HMAC schedule, AES-GCM nonce and tag
   behavior through the phone's real native/JS path. Then compare complete deterministic handshake
   and transport vectors for the selected profile with Node and an independent implementation.
   Record real devices/OS versions separately from Node tests or bytecode compilation.

The ensuing Noise/admission review must also settle limits on bytes per key and reconnect/rekey,
invalid peer behavior, and transcript binding. I recommend empty IK handshake payloads and sending
the bearer only in the first transport record, with daemon application output gated on admission. IK's
first payload can be replayed and lacks forward secrecy against later responder-key compromise;
an early encrypted bearer or command is therefore not equivalent to post-handshake admission.
[Noise payload properties](https://noiseprotocol.org/noise.html#payload-security-properties)

## Relationship to skill signature authority

This decision is independent of [unresolved decision 2](../ROADMAP.md#unresolved-product-decisions).
Skill signatures already use Ed25519 over a domain-separated content-digest message, verified
against a local trust file. Decision 2 concerns who supplies trusted signers, who holds signing
keys, and how signers are revoked. Relay IK authenticates paired endpoints with DH keys and a
current device bearer. It neither chooses a publisher registry nor grants trust to received skill
content. The existing mechanism is visible in [skill-signing.ts](../apps/daemon/src/skill-signing.ts).

The boundaries should stay independent: separate keys, identifiers, trust stores, revocation
events, and message domains. Do not convert or reuse a skill's Ed25519 key as a relay X25519 key,
or let a trusted publisher become a paired device. The two decisions may share operational lessons
about custody and rotation; neither blocks the other or makes its authority decision implicitly.

## Decision for fetzy

**Recommendation, not a settled choice:** preserve the current phone key-operation requirement
and select C, `Noise_IK_P256_AESGCM_SHA256`, using the pinned uncompressed P-256 profile, platform
handles, and a separately reviewed Noise integration. The Android hardware proof strengthens this
recommendation without changing it. Fetzy must choose the supported custody/device policy and
whether to gate release on iOS proof or keep iOS relay unavailable until it is proven. Full phone
composition and the review findings must precede a production schema or release commitment.

Choosing C forecloses an official-revision-34-only suite, the 32-byte responder pin, and unchanged
reuse of #337's codec. It accepts native bridge/build maintenance, extension interop work, and a
relay availability floor determined by protected ECDH support, including Android API 31 or later.
It does not require raising the minimum OS for direct connections. Once C is frozen, switching to
A/B would need a deliberate version/pairing migration, not an automatic fallback.

If fetzy instead prioritizes a standard Noise suite and the smaller handshake, A is my alternative
recommendation, but only after either proving a compliant X25519 key-operation path or explicitly
changing the phone custody requirement. B buys no custody improvement over A; select it only for
demonstrated AES-provider benefits. If neither the extension/review cost nor a custody change is
acceptable, defer relay production. Fetzy's decision is which of those constraints Domovoi will
accept, and who owns the review commitment, before the route contract is frozen.
