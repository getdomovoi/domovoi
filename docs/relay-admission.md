# Relay admission, endpoint half

This admission layer targets the frozen suite A codec at
`531a46b6bbb9e8286c42f9ad60476d4332d792aa`:
`Noise_IK_25519_ChaChaPoly_SHA256`. Nothing under `packages/protocol/relay/`
changes. The separately reviewed codec and its recorded fixtures remain the wire
format described in [relay-wire-format.md](relay-wire-format.md). Admission adds
application records above that codec in `packages/protocol/relay-admission/`.
Its schemas are exported from the ordinary protocol entry without importing the
crypto runtime. Runtime consumers import `@getdomovoi/protocol/relay-admission`.

This is the daemon and client half. `https://github.com/getdomovoi/relay` owns the
future relay server. This repository does not implement its registration,
routing, multiplexing, deployment, or connection establishment. The carrier
hands these endpoints one already selected logical channel. Nothing here
advertises a relay route, dials an endpoint, or falls back to plaintext.

## Pairing and custody

The client generates and retains a 32-byte X25519 private key in its own secret
store. It presents the corresponding canonical, unpadded base64url public key as
`channelPublicKey` during an existing **direct** `device.pair` or `device.claim`.
The daemon persists that public key in the same SQLite row as the paired bearer
hash and client-kind or machine binding. The caller receives the ordinary
credential response plus `relay: { suite, responderPublicKey }` only when it
opted in. The daemon must have a configured static key before minting that
credential or spending a claim code. Public device summaries stay unchanged.

A machine claim retains the key in the pending row. It has no admission authority
until the source durably saves its credential and confirms the claim through the
existing direct path. Migration leaves old device rows without a channel key;
there is no derived key, guessed binding, or automatic relay enrolment. Those
credentials retain their existing direct behavior and cannot enter relay
admission. Re-pair with an explicit key to add relay authority. Bearer rotation
retains the public key and invalidates existing channels. Changing a static key
requires fresh pairing; there is no key-update RPC in this slice.

The responder public key must be saved from the trusted direct pairing response,
not learned from a relay descriptor. A relayed credential must match both the
active bearer record and the static key authenticated by `remoteStaticKey()`.
The daemon root bearer is never accepted, including when copied into a device
record. Knowing only a bearer or only a private key is insufficient.

`DaemonServerOptions.relayStaticKey` requires caller-supplied, persisted secret
material. The daemon copies that key and clears its copy on shutdown. This slice
does not provision it in the live profile, rotate it, or connect the production
transport factory. Client key storage and actual mobile transport wiring remain
integration work. The endpoint wrapper obtains fresh handshake entropy from
`globalThis.crypto.getRandomValues`; an absent or failing platform CSPRNG refuses
construction. A platform adapter must provide a real CSPRNG, never a seeded or
`Math.random` fallback. No test keys are runtime defaults.

## Admission exchange

The runtime validates a strict context:
`{ relayProtocol: 1, routeId, channel: { suite, responderPublicKey } }`.
`routeId` is exactly 32 bytes, encoded as canonical unpadded base64url. It names
an already selected channel. It is public context, not a credential.

The Noise prologue is UTF-8 `domovoi.relay.admission.v1\0` followed by the 32
decoded route bytes. Both endpoints must supply the same bytes. The prologue
binds this context to the exchange; it is not additional key entropy. See the
[Noise prologue specification](https://noiseprotocol.org/noise.html#prologue).

1. Client sends an IK message with an empty payload, exactly 96 bytes.
2. Daemon sends the empty IK response, exactly 48 bytes. Completing this exchange
   alone grants no application authority.
3. Client sends its first encrypted transport record: byte `0`, then UTF-8 JSON
   `{"kind":"credential","token":"<paired bearer>"}`. No identity supplied by
   the client replaces the stored binding.
4. Daemon checks that same active device record against the authenticated remote
   static key, then sends byte `1` and UTF-8 JSON `{"kind":"admitted"}` inside
   encryption. Unknown fields and other record kinds refuse admission.
5. Only then does the client send application records. Its first RPC establishes
   the ordinary `system.hello` identity and protocol compatibility. A machine's
   identity comes from the confirmed credential binding. `authToken` in a relay
   hello is refused; the bearer belongs only in step 3.

No bearer appears in a handshake payload, carrier header, close reason, or
plaintext control record. A failed exchange closes that logical carrier with no
reason payload. Public APIs report a fixed refusal rather than propagating
crypto, registry, callback, or carrier error text. A fresh channel requires a
fresh IK exchange; replaying or resuming an old cipher state is unsupported.

## Application record layout and bounds

Every complete Noise transport ciphertext carries one encrypted record. There
is no additional outer length prefix in this layer; the carrier preserves frame
boundaries. Application plaintext records have this layout:

| Byte offsets | Field |
| --- | --- |
| 0 | Literal `2`, application record |
| 1 through 4 | Total UTF-8 message bytes, unsigned 32-bit little-endian |
| 5 through 8 | This fragment's byte offset, unsigned 32-bit little-endian |
| 9 onward | Message fragment |

Fragments are canonical: offset starts at zero and increments by the preceding
fragment length. Each fragment fills the available 65,510 bytes except the last.
The declared total stays identical throughout a message. Interleaving, gaps,
repeats, shortened middle fragments, oversized totals and malformed UTF-8 close
the channel. The application sees a string only after complete reassembly and
fatal UTF-8 decoding. An empty message has the nine-byte header alone. It does
not become a valid RPC merely because framing accepts it.

| Limit | Value and refusal boundary |
| --- | --- |
| Noise frame | 65,535 bytes, checked before decrypting |
| Admission plaintext | 4,096 bytes including type byte, checked before JSON parsing |
| Application message | 2 MiB of UTF-8, checked before allocation and before sending |
| Fragment payload | 65,510 bytes, accounting for nine header bytes and 16 tag bytes |
| Carrier backlog | 4 MiB per channel including the next ciphertext; invalid counters refuse |
| Admission deadline | 10 seconds from endpoint creation; later handshake progress cannot refresh it |
| Reassembly deadline | 10 seconds from the first fragment; later fragments cannot refresh it |
| Daemon channels | 32 total, including unfinished admission |

These bounds limit this endpoint's allocations and work per frame. The carrier
must enforce its own receive, connection and aggregate queue budgets before
materializing frames. They are not a server-wide denial-of-service guarantee.
The relay still sees timing, sizes, routing metadata and disconnects. This layer
adds no padding or traffic analysis protection.

## Daemon adapter

`DomovoiDaemon.openRelayChannel({ context, carrier })` returns `receive`, `close`
and `closed` for the supplied logical channel. It refuses before startup, during
shutdown, without a static key/device registry, or beyond the channel cap.
`receive` consumes complete opaque frames; encrypted application strings enter
the same RPC dispatcher, mutation queues, audit attribution, terminal ownership
and backpressure as direct clients. No separate privileged relay dispatcher
exists. Terminal traffic stays inside its existing JSON-RPC methods and
notifications, carried by the same encrypted record framing.

The daemon rechecks the bearer, authenticated static key, device ID and stored
binding on every incoming frame after admission and before every outgoing
message. Existing revocation and rotation operations close idle listening
channels immediately. A queued request rechecks authority when it reaches the
handler. The channel cannot restore authentication after a refused protocol
hello. Closing a channel releases its terminal ownership through the existing
reap policy; shutdown closes all channels.

Relay channels refuse `device.pair`, `device.claim`, `device.confirmClaim`,
`device.issueCode`, and `artifact.authorize`. Pairing and recovery retain their
direct boundary. Signed artifact HTTP access is not silently redirected through
an unimplemented relay path. Root-only methods retain the existing paired-device
refusal even after successful admission. Other RPCs retain their existing
permission rules; admission does not approve execution.

Carrier `send` must synchronously accept the complete frame or throw, with an
accurate `bufferedAmount`. The transport delivers inbound frames in order and
calls `close` on disconnect. Treat closure as terminal; do not replay queued RPC
mutations on reconnect. `onMessage` and optional `onAdmitted` callbacks run
synchronously. Callback failures terminate the endpoint. Timers and partial
plaintext buffers are cleared on close. The frozen codec has no destruction API;
dropping its reference does not promise immediate erasure by the JavaScript GC.

## Evidence and limits

`packages/protocol/relay-admission/channel.test.ts` and
`hostile-channel.test.ts` exercise real IK exchanges with independent record
builders: both factors, substituted pins/routes, empty-only handshake payloads,
strict encrypted controls, byte caps, canonical fragments, split UTF-8, replay,
reordering, tampering, fixed deadlines, entropy and carrier failure. Existing
frozen codec fixture tests still compare every recorded byte.

`apps/daemon/src/relay-device-binding.test.ts` checks SQLite persistence,
confirmation, rotation, revocation and legacy rows.
`apps/daemon/src/relay-admission.test.ts` carries opaque frames between real
daemon/client endpoints, then probes direct enrolment, root and mismatched-key
refusals, terminal ownership, ordinary RPC, registry failure, channel caps and
shutdown. It is an in-process carrier proof, not a relay-server, live mobile,
network reconnect, or externally reviewed composition proof. The frozen head
above identifies the codec targeted by both repositories; this admission layer
still needs its own review before production integration.
