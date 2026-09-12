# Protocol version negotiation

`protocolVersion` identifies the wire contract. It stays `0.6.0` in this change.
`buildVersion` and `clientVersion` identify executable releases; their values do
not decide wire compatibility. A client release `1.2.3` can speak protocol `0.6.0`.

## Admission policy

Major and minor components must both match. Patch components may differ. This
rule also applies after wire version `1.0.0`; a minor increment is not implicitly
compatible. There is no downgrade to an older schema or feature negotiation.

| Daemon protocol | Client protocol | Result |
| --- | --- | --- |
| `0.6.0` | `0.6.1` | Compatible |
| `0.6.0` | `0.5.0` | Refused, machine ahead |
| `0.6.0` | `0.7.0` | Refused, machine behind |
| `0.6.0` | `1.2.0` | Refused, machine behind |
| `0.6.0` | omitted | Refused, historical client `0.1.0` |

`system.hello` checks credentials and protocol compatibility before establishing
the connection identity. A mismatch returns JSON-RPC error `-32012`, a message
naming both versions, and validated data containing `kind: "protocol-mismatch"`,
`daemonProtocolVersion`, `clientProtocolVersion`, and `compatibility`. Ordinary
RPCs remain unavailable on that socket. Refusal does not revoke the credential;
a compatible hello can retry on the same socket or after reconnecting.

Machine claims and confirmations check compatibility before spending a pairing
code or confirming a claim. Existing credentials do not bypass a later hello.
These admission checks already existed; the schema fixes below make their
declared patch compatibility usable by snapshot readers too.

## Version and payload validation

One protocol schema now validates hello parameters, pairing claims and
confirmations, fleet descriptors, refusal data, local owner identities, and the
daemon's advertised version option. A version contains three decimal,
nonnegative integers separated by dots, at most 64 characters total. Leading
zeros, suffixes, whitespace, and incomplete versions are refused. Comparison
uses exact integers, so components above `Number.MAX_SAFE_INTEGER` cannot round
two different major or minor values into a match.

`workspaceSnapshotSchema` and `systemHelloResultSchema` accept compatible patch
versions and retain the version actually reported by the daemon. They continue
validating the entire payload and refuse incompatible major or minor versions.
The machine dialer uses these schemas directly; it no longer substitutes its
own version to make a peer snapshot pass validation.

Previously, the dialer validated a value it had just written: it replaced the
peer's version with its own before parsing the snapshot. The separate
compatibility check had already examined the actual peer version, and the
dialer returned only the machine ID. The substitution did not publish a changed
patch; it made the snapshot's version check prove only the substituted value.
Parsing the received snapshot directly removes that self-validation.

Parsing a snapshot proves its format and compatibility with this build. It does
not prove an authenticated hello took place. A client may report negotiation as
successful only after its hello succeeds and the returned snapshot validates.

## Evidence and limits

`packages/protocol/src/protocol-version.test.ts` covers patch preservation in both
snapshot schemas, malformed payload refusal, bounds at every protocol version
reader, and exact comparisons above the safe integer boundary.

`apps/daemon/src/version-negotiation.test.ts` uses real WebSocket connections and
a paired client credential. It covers patch admission, versionless and explicit
mismatch refusals, workspace access after refusal, and retry/reconnect without
pairing again. The machine socket and local owner proof suites cover malformed
peer versions at their respective boundaries.

These tests exercise one implementation with differing declared peer versions.
They do not establish interoperability with an independently released binary.
