# Signed hosted relay claims

This slice implements the O8 contract approved at relay PR #12, revision
`9eeba40`: a public Ed25519 grant for hosted relay eligibility. It provides a
shared schema and signing input plus a pure daemon verifier. It does not issue
real grants, load a signer, enroll machines, contact a registry, persist trust,
or change daemon dispatch. Direct/local access and running work are unchanged.

The only audience is `domovoi-hosted-relay-v1`, and the only capability is
`relay.connect`. There is no terminal, update or administrator capability. A
valid claim is not a bearer or proof of machine-key possession, payment, current
seat availability, paired-device admission or live account status. Hosted
registration still needs current registry policy, an independent route
credential, generation checks and the live concurrent-machine cap. Route IDs
remain public identifiers. D2b client custody and pairing integration are separate.

## Shared protocol

`@getdomovoi/protocol` exports `tierClaimPayloadSchema`,
`tierClaimEnvelopeSchema`, `parseTierClaimEnvelope`, `tierClaimSigningBytes`,
`tierClaimIdentifierSchema`, the audience/capability constants and the payload
and envelope types. The envelope has exactly `{ payload, signature }`.

| Payload field, in signing order | Contract |
| --- | --- |
| `version` | Exactly `1`. |
| `issuer`, `keyId` | Independently expected issuer and a selector for an already trusted key. |
| `audience` | Exactly `domovoi-hosted-relay-v1`. |
| `claimId`, `accountId` | Opaque grant and registry-account identifiers. |
| `machineId` | Existing `machine-` plus 32 lowercase hexadecimal digits. |
| `entitlementEpoch` | Positive safe integer; reject below the independently trusted account floor. |
| `capability` | Exactly `relay.connect`. |
| `maximumMachines` | Positive safe-integer entitlement, not an invoice amount or live occupancy count. |
| `issuedAt`, `expiresAt` | Nonnegative safe-integer UTC epoch seconds, strictly increasing, no more than 3600 seconds apart. |

Issuer, key, grant and account identifiers have 1 through 128 ASCII characters
and match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. There is no trimming or coercion.
The signature is exactly 64 bytes encoded as canonical unpadded base64url:
`[A-Za-z0-9_-]{85}[AQgw]`. Unknown fields and versions refuse.

Use `parseTierClaimEnvelope(bytes)` at the wire boundary. It accepts only a
nonempty `Uint8Array` of at most 4096 UTF-8 bytes, bounds it before decoding,
rejects malformed UTF-8/BOMs, and rejects duplicate decoded JSON member names
even when one name uses an escape. Only the two object levels, strings and
canonical nonnegative decimal integers used by this format are accepted.
Numeric aliases such as `1e0`, `1.0`, `01` and `-0` refuse. Ordinary JSON whitespace,
property reordering and valid string escapes are allowed; decoded values must
still satisfy the strict schema. An object already passed through `JSON.parse`
cannot prove that the original text had no duplicate members. The schema alone
is therefore not the wire parser and does not verify signatures.

`tierClaimSigningBytes(payload)` validates the payload and emits UTF-8 of the
domain `domovoi.tier-claim.v1\n` followed by compact JSON of a fixed array in the
table's field order. The domain ends in one literal LF, not the two characters
backslash and n; the array has no trailing newline. Received object property
order is irrelevant. This is a versioned signing format, not general JSON
canonicalization and not the TUF or daemon identity signing domain.

The literal golden message is pinned in both protocol and daemon tests:

```text
domovoi.tier-claim.v1
[1,"issuer-test","key-1","domovoi-hosted-relay-v1","claim-1","account-1","machine-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",2,"relay.connect",3,1700000000,1700003600]
```

An issuer must consume this helper or prove byte parity with the vector. Test
signatures use ephemeral Ed25519 keys. This slice has no private-key API or
production key fixture. Signing authority remains separate from relay forwarding,
daemon identity, Noise and update signing keys.

## Pure verifier and trusted inputs

`apps/daemon/src/tier-claim.ts` exports `verifyTierClaim(bytes, context)` and
its context/result types. The context requires every field below; missing or
malformed values return `{ status: "unavailable", reason: "invalid-context" }`.

- `issuer`, `audience`, `accountId`, `machineId`: exact independent expectations.
- `now`: trusted nonnegative safe-integer UTC epoch seconds, with no clock-skew grace.
- `maximumLifetimeSeconds`: an explicit positive integer no greater than 3600;
  a narrower caller policy can only reduce eligibility.
- `minimumEntitlementEpoch`: an explicit positive safe integer.
- `keys`: 1 through 64 distinct key IDs, each with a canonical 32-byte base64url
  Ed25519 public key and required integer `notBefore`/`notAfter` bounds.

Public keys are checked for valid non-small-order, torsion-free Ed25519 points.
The existing relay identity point validator supplies only that mathematical
check; no relay trust record or signer authority is imported. Signature verification
uses Node's Ed25519 primitive with the fixed signing input. The claim cannot
choose an algorithm, key URL or key-validity policy.

Each key must have `notBefore < notAfter`. Verification requires
`notBefore <= issuedAt`, `expiresAt <= notAfter`, and
`notBefore <= now < notAfter`, as well as `issuedAt <= now < expiresAt`.
Retaining an old public key does not permit a claim after its retirement time.
Approved rotation overlap still respects each key's own window.

A refused result names invalid envelope/signature, unknown signer, binding
mismatch, key time, claim time/lifetime or stale epoch. Successful verification
returns `{ status: "eligible", claim }`, meaning only eligibility under the supplied
trusted context. The verifier does no I/O, reads no clock by default, mutates no
trusted state and never turns a failure into a permissive fallback.

## Offline limits and deployment prerequisites

The verifier cannot prove the caller's time authentication, continuity or durable
epoch floor. A Boolean claiming freshness would not supply that evidence. A
future production integration must establish authenticated freshness after
restart, lost clock continuity or uncertain/restored revocation state, and persist
new floors without rollback. Until then this pure API is not production offline
authorization.

A verifier with stale but otherwise trusted context may accept an unexpired old
claim after online revocation. Tests demonstrate that remaining window and refusal
once the newer floor is supplied or the claim/key expires. The one-hour maximum
is conditional on trustworthy time, not an unconditional wall-clock revocation
guarantee. A compromised still-trusted signer can mint grants within its window.
Renewal and signer configuration changes need independent authenticated paths.

No test here proves operator account identity, secret custody, live revocation
latency, endpoint admission or running-daemon enforcement. Those require separately
reviewed integration; this slice grants no deployment or D2b authorization.
