# Direct transport contract

`transportCandidateSchema` is a discriminated union on `kind`. Validation checks the endpoint
and the fields permitted for that kind before sorting or dialing. `transportContract` carries
the matching locality, protection, configuration, availability and channel-capability policy
for every kind. Adding a connection kind requires a policy entry; tests require the schema,
policy and preference order to cover exactly the same kinds.

| Kind | Endpoint | Configuration | Dial eligibility |
| --- | --- | --- | --- |
| local | Loopback `ws://` or `wss://` | No configuration field | Candidate |
| wsl | Loopback `ws://` or `wss://` | No configuration field | Candidate |
| lan | Non-loopback, non-wildcard `wss://` | No configuration field | Candidate |
| tailnet | Non-loopback, non-wildcard `wss://` | No configuration field | Candidate |
| ssh | Loopback `ws://` or `wss://` forward | Explicit `configured` boolean | Only when configured |
| relay | Reserved `wss://` record | No configuration field | Unavailable |

Loopback means `127.0.0.1`, `localhost` or `::1` after URL host normalization. Encoded dots and
expanded IPv6 loopback normalize to that set. Other loopback spellings are not supported local
endpoints, and cannot become remote routes merely because they fall outside the allowlist.
No DNS lookup establishes locality. LAN and tailnet are operator classifications, not proof of
network membership or protection. Remote protection comes from daemon-terminated TLS.

Endpoints are bounded to 2,048 UTF-16 code units. Credentials, query strings, fragments,
whitespace and backslash separators are refused. Schemes use lowercase `ws://` or `wss://`.
`fleetDirectEndpointSchema` shares the protected endpoint rule for a source-verified route,
without assigning it an advertised kind. An authenticated observation need not match the
target's advertised hostname.

## Availability and authority

`orderedTransports` validates and orders records for display. `usableTransports` additionally
removes unavailable routes. Dialers must use the latter; `selectTransport` returns its first item.
Neither an absent route nor a failed network attempt becomes a different kind. Existing shared
operation deadlines still govern connection, authentication and fallback.

`authenticated: true` requires authentication, not a claim that a handshake has already
succeeded. A daemon still verifies the paired credential, expected machine identity and protocol
version. Target advertisements cannot configure SSH on the source or authorize a remote peer's
loopback endpoint. Source-local SSH settings and source-verified endpoints retain their separate
provenance, credential checks and pending-forget masking.

The direct kinds can carry RPC, terminal and preview traffic. These are channel capabilities,
not a grant of machine features or client authority. Policy is exported data, not extra
caller-controlled wire flags. In particular, daemon-to-daemon enrollment does not grant the
desktop a client credential for remote Use or Terminal.

Relay has no capabilities and is never selected, including when a legacy caller passes
`relayAvailable: true`. Keeping a reserved record does not implement a relay, freeze a crypto
suite or authorize sending a bearer through a relay. Its eventual encrypted descriptor and
artifact path remain separate Goal 3 work. WSL discovery and the open shim likewise do not
constitute a fleet transport producer.

## Producer and upgrade boundary

Producers validate their output. A loopback advertised host is classified as local even when
the listener binds a wildcard address. The bound port, explicit tailnet classification and
source-local SSH-forward order remain unchanged.

Valid direct records retain their wire shape. Contradictory records formerly accepted by the
flat schema are refused, not silently rewritten into a guessed route. This tightening requires
the F8 damaged-row quarantine before release so an old invalid cached descriptor remains
recoverable instead of failing the whole fleet list. Re-enrollment reads fresh target facts;
changing validation alone must not invent them.
