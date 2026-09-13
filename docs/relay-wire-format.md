# Frozen relay IK codec

Status: suite A selected on 2026-09-12. The composition and its byte contract are
frozen for external review. Review has not completed. This does not enable relay
connections or claim that the composition has been audited.

The decision is recorded in [sections 7a and 9 of the crypto ruling](https://github.com/getdomovoi/domovoi/blob/0a91c532d21c8c58163673ac7ed5e942aa93ef85/S0.2-RELAY-CRYPTO.md).
It selects our noble composition of `Noise_IK_25519_ChaChaPoly_SHA256`, without a
Snow adapter. The separate private relay-server repository is outside this slice.
The public wire/client module lives in `packages/protocol/relay/`.

## Frozen composition

The public entry point is `@getdomovoi/protocol/relay`. It exports `createNoiseIk`,
`relayNoiseSuite`, and the `NoiseIkOptions` type. There is one runtime path, using
`@noble/curves`, `@noble/ciphers` and `@noble/hashes`, each pinned to exactly 2.4.0.
The ordinary protocol entry point does not import the relay codec.

The composition is `relay/noise-ik.ts`; `relay/index.ts` is its export boundary.
`relay/testing/` contains public fixtures and the Node comparison oracle. None of
that directory is built or published. The oracle is evidence, never a backend
selected by platform or on error. AES-GCM and P-256 implementations and vectors
have been removed. Historical measurements remain under `docs/relay-measurements/`.

The following byte rules follow [Noise revision 34, sections 4, 5, 7 and 12](https://noiseprotocol.org/noise.html):

- Suite name: `Noise_IK_25519_ChaChaPoly_SHA256`. No negotiation or fallback.
- X25519 public keys and DH results are 32 bytes. The responder static key is
  pinned before the handshake. An all-zero DH result is refused.
- The 32-byte suite name initializes the transcript and chaining key verbatim.
  Prologue and responder public key are mixed into the transcript before IK.
- First message: `e, es, s, ss`. Bytes are initiator ephemeral key (32), encrypted
  initiator static key (48), then encrypted payload (payload length plus 16).
- Reply: `e, ee, se`. Bytes are responder ephemeral key (32), then encrypted
  payload (payload length plus 16).
- SHA-256, HMAC-SHA-256 and Noise's two-output HKDF derive handshake and transport
  keys. Split output one sends initiator to responder; output two reverses it.
- ChaCha20-Poly1305 appends a 16-byte tag. Its nonce is four zero bytes followed
  by a little-endian 64-bit counter. Each directional counter starts at zero;
  `2^64 - 1` is reserved and refused. No rekey or counter reset is exposed.

For this codec, a complete handshake or transport message is at most 65,535
bytes. The runtime checks bounds before cryptographic operations. Handshake
payload maxima are 65,439 bytes for the first message and 65,487 for the reply;
transport plaintext is at most 65,519 bytes. All binary inputs must be Uint8Array
instances. Prologues are bounded at 65,535 bytes, and private keys at 32 bytes.

The codec consumes and returns complete messages; it does not add an outer
length prefix, route identifier, frame-class marker, JSON encoding or padding.
The later relay framing and admission layer is not frozen or implemented here.

## State and failure contract

An initiator writes once, reads once, then uses transport. A responder reads
once, writes once, then uses transport. `handshakeHash()` returns a copy only
when the handshake is complete. `remoteStaticKey()` returns a copy of the
authenticated peer key at that same boundary, for later device admission.
Handshake AEAD authenticates the running
transcript; transport AEAD has empty associated data and independent ordered
counters. A successful decrypt advances its receive counter.

Invalid inputs, ordering, pins, authentication or exhausted counters produce
`Relay channel rejected`, without a nested primitive error. A failed operation
terminates both directions on that instance. Replayed, reordered or corrupted
transport records cannot be retried on it. Create a fresh connection instead.
Caller key buffers are copied. Handshake private-key copies are cleared after
split; retained cipher keys are cleared on terminal failure. This is best-effort
JavaScript buffer clearing, not a guarantee that a runtime erased every copy.

Any later change to this composition's byte interpretation, algorithms, key
schedule, nonce handling or accepted state transitions requires an explicit
compatibility break and another review. Do not update vector expectations to
bless changed output. The reviewed commit will be named in the review brief;
changes after that head cannot silently inherit its review.

## Required integration boundaries

The low-level Noise codec accepts handshake payloads to reproduce published
Noise vectors. The Domovoi relay profile must send and accept **empty handshake
payloads**: 96-byte first message, 48-byte reply. That profile enforcement belongs
to the later admission layer. The first IK message is replayable and is not
forward secret against later compromise of the responder static key. It must
carry no bearer or application action. Send the current bearer only in the
first transport record, after the responder ephemeral exchange.

That layer must bind the authenticated channel key and current bearer to the
same active paired device, refuse the daemon root credential and recheck
revocation. A transcript hash alone is not a device admission decision. The
codec exposes the authenticated peer key but supplies neither a device registry
nor that binding. Pairing stays direct.

Each caller must supply fresh cryptographic ephemeral keys for every handshake,
a pinned responder key from direct pairing and an agreed, authenticated prologue.
There is no key generator, entropy fallback, persistence or keychain adapter in
this module. Suite A uses exportable software X25519 key material on phones;
platform storage, backup exclusion, loss/revocation handling and full Hermes
execution remain integration work. The cold identity signing key is separate
from the warm skill-signing key and from these channel keys.

No relay server, sockets, RPC admission, tier framing or private repository is
created here. The operator may observe addresses, timing, sizes, route ids and
connection counts. Traffic class must not become a cleartext quota field.

## Evidence and limits

The unchanged Cacophony fixture pins two handshake frames, four transport frames
and the final transcript hash. Both role combinations also interoperate with
the test-only Node oracle. Refusal tests cover suite mismatch, invalid input,
prologue and pin changes, low-order points, tampering, replay, reordering,
truncation and terminal state. Boundary tests compare noble against the Node
oracle across the 32-bit counter boundary and at the last usable 64-bit counter.

Those tests and the mobile Node runner are execution evidence, not an external
cryptographic review or execution of the full codec on a phone. Historical
primitive audit claims do not establish an audit of this composition or of
these exact dependency versions. External review remains outstanding.
