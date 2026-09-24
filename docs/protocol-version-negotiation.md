# Protocol version negotiation

`protocolVersion` identifies the wire contract. Its current value is `protocolVersion` in
`packages/protocol/src/protocol-version.ts`. `buildVersion` and `clientVersion` identify
executable releases; their values do not decide wire compatibility. A client release
`1.2.3` can speak protocol `0.6.0`.

## Admission policy

Major and minor components must both match. Patch components may differ, because
a patch carries no wire change: every change to a protocol schema, including an
added optional field, is a minor bump. Schemas stay strict, so a peer on another
minor could not parse the change anyway. This rule also applies after wire version
`1.0.0`; a minor increment is not implicitly compatible. There is no downgrade to
an older schema or feature negotiation.

CI enforces the bump, per release: every wire change between two protocol releases
shares one minor bump. Each released protocol version has a record of its wire in
`packages/protocol/wire-releases/<version>.json`, written once, from the release
commit, with `node scripts/protocol-wire.mjs record`. The wire is what crosses a
socket: every RPC's params and result, the payload of every notification the daemon
sends, and the structured data it attaches to errors. Each entry is a digest of the
schema's JSON Schema and of its checks, including the bounds of the UTF-16 length
helpers, which JSON Schema cannot express.

`node scripts/protocol-wire.mjs check` compares the built package with the record of
the highest release at or below its `protocolVersion`. At that same version, or a
patch of it, any wire change fails and the changed entries are listed. With a higher
minor or major, the check passes: the changes since that release share the bump. No
release record at or below the current version also fails. The check needs no tags.

At a protocol release, commit its record from the release commit:
`pnpm --filter @getdomovoi/protocol build`, then
`node scripts/protocol-wire.mjs record`. To record an earlier release, build that
commit in another checkout and pass `--package <that checkout>`.

Descriptions, titles and examples are left out of the digest: they document a
schema and do not change what parses.

Known limit: a custom check's function source is part of the digest, but a value a
check captures in a closure is not, unless the check declares it the way
`utf16MaxLength` and `utf16Length` do, or through `wireRule(schema, { rule, ...values })`.
The digest can refuse any custom check that declares nothing (fail closed), but
the wire record does not require that yet: whether to annotate every custom check
or to keep this stated gap is still to be decided.

For example, with a daemon on `0.6.0`:

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
