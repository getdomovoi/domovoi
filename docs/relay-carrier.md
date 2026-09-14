# Relay carrier version 1

`packages/protocol/src/relay-carrier.ts` defines registration, logical-channel
selection, public recovery delivery, and multiplexing outside the encrypted
endpoint protocol. It targets the frozen codec at
`531a46b6bbb9e8286c42f9ad60476d4332d792aa`. Neither that codec nor the
`RelayPinStore` contract changes. [Endpoint admission](relay-admission.md) still
owns the empty IK handshake, encrypted paired credential, receipt, and nine-byte
encrypted application header.

This slice defines records and parsers, not a listener or dialing policy.
Carrier version 1 is explicit in greetings and acknowledgements. Unknown
versions, record kinds, and extra fields refuse. Incompatible changes require
a new carrier version. The layout is pinned in
`packages/protocol/src/relay-carrier.test.ts`.

## Connection roles and ordering

A carrier uses ordered WebSocket messages over WSS. Control records are UTF-8
JSON text messages; opaque frames are binary messages. Registration credentials
are visible to the relay, so a registering daemon must validate the WSS server's
certificate and hostname before sending its greeting. They must be independently
issued, not copied from a daemon root token, paired bearer, or channel key.

| First record | Fields besides `kind` | Response |
| --- | --- | --- |
| `register` | `carrierVersion`, `routeId`, `machineId`, `generation`, `registrationCredential`, `recovery` | `registered` with the same version and generation |
| `connect` | `carrierVersion`, `routeId` | `connected` with the same version |
| `recover` | `carrierVersion`, `routeId`, `machineId` | `recovery` containing the publication, then close |

`routeId` and `registrationCredential` use canonical, unpadded base64url for
32 bytes. Registration generation is a positive safe integer for connection
fencing, separate from the identity's signed generation. Channel identifiers are
positive 32-bit integers scoped to one registered connection. Route identifiers
select a destination; they grant no daemon RPC authority. The private service
authenticates registration, enforces its generation fence and account policy,
and bounds registration attempts before publishing the route.

Only a greeting is allowed first. A registered daemon may receive `open` and
`close` records containing `channelId`; it may send `close` for its own logical
channels. `registered` must precede every `open`. A connecting client waits for
`connected` before starting IK. After connection selection, that client carries
only one logical channel. It sends and receives complete opaque binary frames
without a multiplex header. The relay must not treat a second greeting as a
role change. These ordering and role checks belong to adapters; schema validity
alone does not establish a valid transition.

Each daemon binary message contains a multiplex header and exactly one opaque
frame. The client-facing side receives that frame with the header removed.

| Byte range | Value |
| --- | --- |
| 0 through 3 | Unsigned channel identifier, little-endian, nonzero |
| 4 through end | One unchanged endpoint frame, 1 through 65,535 bytes |

The maximum daemon binary message is 65,539 bytes. Identifiers are never reused
within a registration. An identifier never issued on that registration is a
protocol refusal. Frames arriving for a previously issued, already closed
channel are discarded; they can be in flight when its peer closes. They must
never reach another channel. Closing or replacing the daemon registration
closes all its channels. No queued mutation is replayed after reconnect.

## Recovery before admission

An offline client can use `recover` on next contact when its old channel pin no
longer admits it. Fetch deliberately accepts no bearer or caller-supplied trust
anchor. Its trust comes from the cold identity signature, verified against the
client's saved pin by `adoptRelayRecovery`. A fetched identity is never used to
enroll a new pin. This is the purpose of the cold key, not an authentication
exception to close later.

The publication reuses `relayRecoveryResultSchema`: current identity plus the
latest signed successor when generation is greater than one. A registration
must publish it for the same machine named by the registration. Provisioning
precedes registration; a daemon without a publication cannot register. A receiver
must also bind the response to its requested machine and saved pin. The schema
checks field consistency and bounds; it does not verify signatures or prove
that the registering process owns the advertised private key. The daemon must
source the publication from its active, bound `relay.recovery` result. Endpoint
admission proves channel-key possession.

An unavailable route refuses. Source and aggregate
request budgets, machine scoping, and registration authentication remain
required at the server. Forwarded address headers are not an observed source.
Latest-only delivery cannot supply a missing intermediate successor; that case
requires intervening statements or trusted direct re-pairing.

## Bounds and remaining proof

Control input is capped at 4,096 bytes before UTF-8 decoding and JSON parsing.
The recovery publication retains its own 2,048-byte cap. Decoding refuses
invalid UTF-8. Binary decoding and encoding validate frame and identifier bounds
and return owned bytes, including when the input is a Node Buffer or offset
view. The relay does not parse the encrypted application header or credential.

Adapters must enforce receive, connection, source-rate, timer, and aggregate
queue bounds before materializing input. These parsers do not establish those
network limits. The private server's queue notifications and usage meter are
implementation details, not new wire fields. The server, daemon connector,
real endpoint integration, reconnect behavior, and deployment remain separate
work; a successful schema test proves none of them.
