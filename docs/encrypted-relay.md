# Encrypted relay transport and commercial rendezvous

Status: agreed design direction on 2026-09-04, including the corrected open-core licensing
boundary. Credential prerequisites are implemented. The cryptographic suite and library are
deliberately unresolved, and no relay wire or networking is implemented yet.

## Requirement and scope

The immediate requirement is stable reachability while an execution machine changes network
identity, including when a laptop switches between tailnets. Both the daemon and a phone connect
outward to one stable rendezvous. Neither endpoint needs to accept a new public inbound listener
or remain on the same private network.

The first operational relay does not require the full hosted Goal 3 stack: Domovoi accounts,
subscriptions, entitlements, billing, guest sessions, or multitenant routing. It may be deployed
privately for project dogfooding before those services exist. That deployment mode does not make
the official relay a free self-hosted component.

Direct private transports remain preferred. The relay is the last transport, used only when a
configured encrypted route is available.

## Open-core and trust boundaries

The Apache-2.0 protocol defines the route and encryption contract. The Apache-2.0 daemon owns the
outbound connection manager and may dial any endpoint that conforms to that contract. The official
rendezvous implementation and operated service are commercial components. Publishing an open wire
contract does not put the official server implementation into the Apache distribution.

This split keeps the open daemon useful and avoids binding it to one service URL. It also lets the
project dogfood a privately deployed commercial rendezvous before the hosted account system is
ready. Domovoi does not offer the official relay server as a free self-hosted package.

The official relay is a separately licensed and distributed app, not a `domovoid relay serve`
mode. That is both a licensing boundary and a security boundary. The two processes have opposite
threat models:

- `domovoid` executes project code and holds provider and device credentials on a trusted
  execution machine.
- the relay accepts sockets from the public internet, executes no project code, and holds no
  Domovoi endpoint credentials or plaintext session content.

Putting both roles in one binary would make it too easy to expose the daemon while intending to
deploy only the rendezvous, and would put a commercial component inside the Apache-2.0 daemon
artifact. The production relay must not land in that binary or distribution. A bounded fake relay
used only by tests may live in the open repository because it is not the operated implementation.

The daemon keeps an outbound WSS registration open. A client opens a second outbound WSS
connection for the same opaque route. The relay multiplexes bounded binary ciphertext frames
between them. A random 32-byte route id makes route discovery infeasible, but it is routing
metadata, not endpoint authentication.

The relay registration secret is separate from the daemon root token, paired-device bearers, and
channel keys. It only authorizes claiming a route and supports abuse controls. Compromising it can
deny or misroute service, but must not authenticate an endpoint or decrypt an accepted channel.

## Public route descriptor

The public descriptor has this agreed logical shape:

```ts
type RelayRouteV1 = {
  endpoint: WssUrl
  routeId: Base64Url32Bytes
  relayProtocol: 1
  channel: {
    suite: RelayChannelSuiteV1
    responderPublicKey: Base64UrlPublicKey
  }
}
```

`endpoint`, `routeId`, and `relayProtocol` are settled. The exact `channel.suite` literal and the
public-key byte constraint are not production schema yet; the crypto spike below must select and
prove them first. `Noise_IK_25519_ChaChaPoly_SHA256` is a candidate, not a decision.

The client stores the descriptor with its paired machine. The descriptor contains public routing
and key-pinning material only. The relay registration secret, a device bearer, and every private
key are excluded from fleet snapshots and route descriptors.

`transportCandidate` becomes a discriminated union when this schema lands. Direct candidates
retain their current endpoint shape. A relay candidate carries `RelayRouteV1` plus
transport-scoped capabilities. Capability availability must be data in the protocol, not a list a
client remembers independently.

Relay v1 carries encrypted JSON-RPC and terminal traffic. It does not advertise artifact previews,
downloads, or print URLs. Those use signed HTTP access today and have no encrypted relay byte path.
Preview capability stays absent until such a path exists; clients must explain that previews need
a direct connection rather than silently hiding them.

## End-to-end channel and admission

TLS protects each connection to the rendezvous. A separate end-to-end authenticated encryption
channel protects Domovoi frames from the relay itself.

The daemon has a persistent static channel key. Its public key is pinned during direct pairing.
Each paired device has its own static channel key, and the daemon stores that device's public key
on the paired-device record. Every logical relay connection performs a fresh handshake and gets a
fresh transport cipher.

On a phone, the device private channel key is generated and used inside the platform keychain. It
is device-only, non-synchronizing, excluded from backups and exports, and never returned through
Domovoi protocol state or logs. Forgetting a daemon deletes both its bearer and its private channel
key. If the key is lost, the device must pair again; no recovery path exports it to another device.

Relay admission requires two factors belonging to the same active device record:

1. proof of the paired device's private channel key; and
2. the device's current bearer credential, sent only inside the encrypted channel.

This is endpoint admission, not user-facing MFA. A stolen bearer alone and a stolen key alone are
both insufficient. Keeping the bearer in the check preserves immediate revocation and rotation;
proof of the key prevents a copied bearer from being sufficient on the public route.

The daemon root token is never accepted on relay ingress. Each accepted request rechecks that the
device record remains active. Revocation or rotation closes its live relay stream instead of
waiting for a reconnect.

A paired client bearer grants full ordinary client authority. It can send or steer work, answer
approvals, and use terminals; it is not a read-only discovery token. The relay's second factor
reduces what a copied bearer can do from the internet, but does not make the bearer low-value.

A machine credential authenticates the source machine, not the human named in transferred
`initiatedByClient` provenance. A stolen machine credential can assert that provenance. Requiring
the corresponding channel key on relay ingress is the boundary against a bearer-only theft; it
does not turn carried provenance into cryptographic proof of the person.

## Pairing boundary

Initial pairing is direct-only for the alpha: local IPC, WSL interop, LAN, tailnet, or an explicit
SSH tunnel. The daemon enforces this rule even if a client mistakenly offers the action.

The current spoken pairing code has about 21.5 bits of entropy and allows five online attempts.
That is reasonable inside the private pairing boundary and enumerable if a stored digest is taken
offline. It must never be the only secret protecting internet-reachable enrollment. Relay pairing
would require either a pinned daemon key delivered out of band or a real password-authenticated
key exchange; neither exists today.

Existing pairings without channel public keys stay direct-only. Enabling their relay route requires
an explicit direct re-pair after the channel suite is selected.

## Connection lifecycle

The daemon-side outbound manager owns reconnect jitter, heartbeat, and a monotonically fenced
route generation. An older network path cannot replace the latest registered socket after a
tailnet or interface change.

Every reconnect performs a new end-to-end handshake. Sequence-checked AEAD rejects tampering,
duplicate ciphertext, and reordering. A disconnected mutating RPC is never replayed automatically;
the client reconnects, performs `system.hello`, resynchronizes canonical state, and lets the person
decide whether to issue another mutation.

The relay persists no payload. It enforces bounds on pre-authentication bytes, frame size, stream
count, per-route buffers, and idle time, with explicit backpressure and uniform unknown-route
responses.

## Metadata boundary

A relay operator sees addresses, timing, sizes, route ids, and connection counts and can delay or
drop traffic. A hostile relay can also replay ciphertext, although endpoint sequence checks reject
it. The relay cannot read or forge accepted plaintext if the end-to-end channel is correct.

This is the central public promise of the commercial relay, not optional defense in depth: the
company operating the rendezvous cannot read session content. The relay does not ship until tests
and protocol evidence support that claim. It is not zero knowledge, because the operator still
observes the metadata above and controls availability. Documentation and client copy must state
both halves plainly.

## Open cryptography decision

The next slice is a cross-runtime crypto spike and codec with no networking. It must work in Node
and the phone runtime without assuming `node:crypto` or generally available WebCrypto.

The candidate is Noise IK over X25519, ChaCha20-Poly1305, and SHA-256, potentially using
`@noble/curves` and `@noble/ciphers`. Before any suite literal enters the protocol, the spike must:

- verify React Native bundling, secure randomness, and private-key storage;
- verify the libraries' audit and maintenance claims rather than relying on reputation;
- use published deterministic handshake and transport vectors;
- prove transcript binding, tamper rejection, replay rejection, and downgrade refusal;
- prove that no bearer, private key, JSON-RPC plaintext, or error text crosses the relay boundary;
  and
- decide whether an audited Noise layer exists or whether assembling primitives would create an
  unacceptable custom-protocol burden.

The protocol schema follows that evidence. A permissive placeholder suite or key shape must not be
shipped merely to let networking start.

## Delivery slices

1. Credential prerequisites: strong fixed-width credentials, exact client or machine bindings,
   verified durable attribution, hello-time activity, and a single migration for both legacy
   credential shapes. Implemented. Channel keys wait for the crypto decision.
2. Cross-runtime crypto spike and codec with deterministic vectors and no networking. Next.
3. Protocol route, channel-key, and transport-capability schemas, reviewed before callers build on
   them.
4. In-process hostile-relay tests proving plaintext and endpoint credentials never cross the
   rendezvous boundary.
5. Open daemon outbound manager plus the separately licensed commercial relay app, with generation
   fencing, bounds, and backpressure.
6. Phone connection using its stored descriptor and paired device factors.
7. Encrypted artifact delivery before a relay route can advertise preview capability.

A privately operated commercial relay may precede Goal 3 for dogfooding. Hosted accounts,
entitlements, billing, guest access, and multitenant scaling remain Goal 3 work. The exact repository
and delivery channel for the commercial server must be settled before slice 5, but it cannot be
part of the Apache-2.0 daemon binary or package.

## Parked findings

The older Goal 2 fleet implementation still needs its planned second review. Transfer is excluded
because its ownership and recovery contract already received joint review. Resume in this order:

1. credential enrollment, revocation, rotation, and the authority available to a stolen or copied
   device token;
2. transport selection, authentication, fallback ordering, and reconnect behavior;
3. the bootstrap install script plus systemd, launchd, and Windows logon-task supervision; and
4. WSL discovery and the Windows interop shim.

One concrete lifecycle gap is already known: `MachineCredentialStore.forget()` has tests but no
production caller. An outbound credential cached for another machine remains in the OS keychain
until another value overwrites it. The audit must decide which observed revocation, removal, or
re-pair event authoritatively permits deletion, then wire and test that lifecycle without exposing
credential bytes.

An adjacent client-semantics finding is also parked: `session.send` steers an active turn rather
than starting another one, but the desktop composer does not tell the person when sending means
steering.
