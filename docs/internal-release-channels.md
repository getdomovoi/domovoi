# Internal release channels

Status: preparation only, 2026-10-11. Desktop and web are the first M2 invite-beta
surfaces. Internal delivery still requires signed artifacts and an explicit
release decision. This document neither enables publishing nor dispatches a
signing workflow. It does not close SHIP-PLAN S1.4, S4.2, S4.5 or S4.6.

## Delivery boundaries

| Surface | Existing mechanism | Remaining evidence |
| --- | --- | --- |
| Managed daemon | `update.status`, `update.check` and `update.activate` dispatch restricted to the loopback local owner; metadata discovery and staging | Conforming verification, scheduling, idle-safe activation, crash rollback, native activation matrix and reproducible-build record |
| Desktop | Manual `desktop-signing` workflow and platform verification described in [desktop signing](desktop-signing.md) | Owner-provided signing access, verified artifacts, internal update delivery and recovery proof |
| Web | Built browser client, separate from the managed daemon runtime | Authorized hosted delivery and browser acceptance against the supported daemon version |
| Native mobile | Native client source and local tests | Signed device artifacts, store beta admission and device update proof; see [mobile readiness](mobile-store-readiness.md) |

The daemon updater is not a desktop or mobile updater. The current daemon
activation dispatch refuses activation until its idle-boundary and platform
matrix are implemented. Do not describe an internal channel as automatic updates
merely because discovery or staging succeeds.

`packages/protocol/src/update.ts` supports the daemon channels `stable` and
`beta`. An internal cohort is an access policy for a chosen channel, not a new
wire value named `internal`. Adding another protocol channel requires a separate
runtime-schema change and compatibility review. Release assets must bind their
channel, version, source commit, target bytes and runtime lock; moving a tag or
renaming an asset cannot establish that binding.

## Trust and admission gates

Preserve the recorded [daemon update design](daemon-auto-update-design.md):
2-of-3 offline root keys, protected reviewed online roles, an independently
published initial root digest, and explicit key-loss recovery. The initial three
root holders are the maintainer; do not claim independent compromise tolerance
from that arrangement. The ceremony, protected-environment proof and trusted-root
distribution remain operational evidence, not a document checkbox.

An internal release must satisfy the same verification boundaries as a public
one: valid role thresholds, root rotation, expiry/rollback protection, exact
artifact length and digest, bounded downloads and compatible runtime metadata.
The release record must include the SBOM, digests and S4.6 two-clean-build
comparison before activation is enabled. A checksum downloaded beside an archive
is not an independent signing authority.

Keep release access separate from relay entitlement. Receiving a beta artifact
must not grant a machine route; an invite or route credential must not grant
release-signing authority. The invite/account issuer, hosting, regions,
availability commitment and certificate arrangements remain owner decisions.
No document here chooses them.

## Operator release record

Before a rollout, name the release operator and approval record, then preserve:

- source revision, release version, channel and intended cohort;
- immutable artifact identities, SBOM and digest manifest;
- signing verification and trusted-root ceremony references, without keys;
- reproducible-build comparison and the exact CI verdict;
- supported daemon/client compatibility and installation prerequisites;
- isolated install, update, interrupted update and rollback results;
- staged rollout bounds, stop criteria, support contact and recovery instructions.

Select a small explicit cohort only after these gates pass. On failed verification
or activation, stop expansion and report the specific failure without content or
credential-bearing logs. Recovery must follow the verified rollback mechanism;
do not bypass expiry or rollback protections to reinstall older vulnerable bytes.
The operator decides whether a corrected release or manual recovery is required.

[Distribution](distribution.md) and [release setup](release-setup.md) own the
canonical artifact and publication workflow. The manual desktop signing workflow
has no publication permission. A successful signed build does not authorize
attaching it to a release. The hidden `desktop-v0.0.1` remains a draft; this work
neither rebuilds nor republishes it.

No account setup, signing run, hosted release, update rollout or device-store
submission was performed for these documents.
