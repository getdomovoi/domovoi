# Daemon auto-update design

Status: design for S1.4. Signing authority and key custody decisions were made
by the maintainer on 2026-09-14. Discovery, verification, and staging may start;
the activation matrix and reproducible-build comparison remain required.

## Scope and current baseline

S1.4 covers the managed daemon runtime installed by the verified bootstrap path.
It does not update a repository checkout, a global package-manager installation,
the desktop or mobile apps, provider CLIs, or host packages.

The release path already supplies useful integrity evidence:

- `scripts/release-artifacts.mjs` packs the protocol and daemon once, binds the
  same-release protocol archive into the daemon runtime lock, writes SHA-256
  checksums and SBOMs, and refuses an unexpected production graph.
- `scripts/release-plan.mjs` binds those bytes to one source commit. The publish
  job rechecks the downloaded workflow artifact before publication and refuses
  registry or GitHub assets with different bytes.
- npm trusted publishing supplies hosted provenance. That says which workflow
  and commit produced a package. It is not an updater trust root by itself.
- `scripts/bootstrap-install.mjs` downloads one caller-pinned version, verifies
  two matching checksums, installs dependencies from a locked integrity graph,
  loads the native module, and publishes an immutable per-version receipt only
  after verification.

Checksums fetched beside an archive authenticate nothing. The bootstrap command
therefore still needs a digest obtained elsewhere. No signed update metadata,
version discovery, rollback protection, automatic activation, or reproducible
second build exists.

## Threats the design must answer

Assume an attacker can control the download host, DNS, a mirror, and every byte
returned to the updater. Also consider a compromised online release credential,
an older correctly signed release replayed after a fix, metadata held forever,
mixed metadata and artifact versions, interrupted staging, two concurrent update
attempts, a crash during activation, and a new runtime that cannot start.

The updater cannot defend a machine after its local user account or root is
compromised. That actor can read daemon credentials and replace the updater and
its pinned keys. Native macOS and Windows code signing still matters to their
platform installers, but those certificates do not uniformly authenticate the
daemon tarball on Linux, macOS, Windows, and WSL.

## Signing authority decision

### A. TUF roles with an offline threshold root, recommended

Ship trusted TUF root metadata with the daemon. Keep threshold root keys offline.
Delegate short-lived targets, snapshot, and timestamp roles to keys usable by the
protected release workflow. Targets metadata binds the exact daemon archive name,
length, SHA-256, version, source commit, channel, and runtime-lock digest. The
client follows the TUF update workflow and persists trusted metadata versions.

The embedded root is only as trustworthy as the out-of-band digest that the
bootstrap caller pins. The root ceremony must publish the initial root digest
where that caller obtains the archive digest, and the bootstrap must verify both
values before trusting the installed root. Publishing the root digest only inside
the archive does not create an independent trust anchor.

This is the only option here that directly specifies root rotation, threshold
trust, key compromise recovery, rollback refusal, mix-and-match refusal, and
expiration for freeze detection. Use a conforming library rather than a local
signature composition. Selecting a library version must verify its declared
engine floor against Domovoi's `>=22.13.0` floor and record the exact package
version used for that decision.

The first discovery implementation records a temporary deviation from this
library requirement. It uses a small Ed25519 verifier and TUF-shaped parser while
the dependency choice is reviewed. Adoption must check the declared library
floor against Node `>=22.13.0`; the current tests cover root
thresholds, expiry, replay, metadata binding, and target rollback refusal. This
deviation must be removed or explicitly accepted before S1.4 activation ships.

Maintainer decisions:

1. Root threshold and holders. Recommendation: 2 of 3 offline keys held in
   separate hardware-backed or encrypted offline custody.
2. Online role custody. Recommendation: separate targets, snapshot, and
   timestamp keys in a protected GitHub environment, with the shortest practical
   expiry and required review. They are not repository secrets available to pull
   requests.
3. Initial trusted root bytes and the ceremony that records their digest.
   The ceremony publishes that digest beside the independently distributed
   bootstrap archive digest so the bootstrap caller can verify both.
4. Recovery procedure when an online role key or a root holder is lost.

### B. GitHub or Sigstore identity attestation

Sign an artifact attestation from the protected release workflow and ship its
verification bundle. This avoids an owned long-lived online signing key and binds
the artifact to the repository, workflow, and commit. Offline verification still
needs a trusted Sigstore root snapshot, and that snapshot rotates. Attestation
alone does not define update ordering, rollback state, freeze expiry, delegated
key recovery, or channel policy. Those mechanisms would still have to be built.

This is valuable provenance alongside A. It is not the recommended sole updater
authority.

### C. Native certificates plus npm provenance

Require Authenticode or Apple Developer ID where available and npm provenance for
the package. This leaves Linux and the cross-platform daemon archive without one
uniform trust root. It also leaves rollback and freeze policy unspecified. Keep
these proofs for distribution, but do not use them as S1.4's updater signature.

## Update repository and metadata

Under option A, publish a versioned TUF repository as immutable assets of the
canonical GitHub release. The update base URL is configured at installation and
must use HTTPS, but authenticity comes from TUF metadata and the embedded trusted
root. Redirects may not change to an unapproved origin unless the signed mirror
configuration allows it.

Use consistent target names. The daemon target is
`getdomovoi-daemon-<version>.tgz`. Its custom targets fields carry:

- schema version;
- canonical Domovoi version and channel;
- 40-character source commit;
- daemon runtime-lock SHA-256;
- minimum updater version, when a metadata or installer migration needs it.

Every network object has a byte limit before allocation or parsing. Every fetch
has one total deadline, an inactivity deadline, redirect and origin limits, and a
bounded error body. Unknown fields and unsupported metadata versions refuse.
Signature and trusted-metadata verification finish before artifact installation.

The client stores trusted root, timestamp, snapshot, and targets metadata in the
profile through a private, atomic, flushed replacement. A lower metadata version,
a same-version different body, expired metadata, an unexpected target, or a
length or digest mismatch refuses the update and records a bounded diagnostic.
Clock rollback is reported separately because expiry cannot establish freshness
without a credible local clock.

Rollback protection means corrected bytes cannot reuse a failed version. If the
highest signed target cannot start, the watchdog restores the prior receipt and
the daemon quarantines that exact version and target digest instead of staging it
again on every check. The release operator must publish a higher metadata version
that removes the target or marks its digest withdrawn. A corrected release uses a
higher application version. Until one of those signed changes arrives, the old
runtime continues and status names the quarantined target. A local operator may
disable the channel while waiting; ordinary scheduled checks never clear the
quarantine.

## Reproducible release proof

One successful pack followed by a checksum is an integrity check, not a
reproducible build. The release workflow must run the release artifact build in
two clean jobs from the same commit and pinned toolchain inputs, then compare the
bytes of both package archives, both SBOMs, and `SHA256SUMS`. Publication consumes
one of those already-compared artifacts. It does not rebuild after comparison.

The comparison must start without shared `dist`, package-manager store, release
directory, or generated runtime files. A mutation test changes a packed byte in
one job's fixture and proves the comparator refuses. The release record publishes
the source commit, workflow run, Node and pnpm versions, artifact hashes, and the
comparison result.

The target machine compiles `node-pty` against its own Node, OS, libc, and native
toolchain. That materialized native output is not a publisher-supplied build and
is not claimed byte-reproducible. Its input package integrity, reviewed install
hook, resulting dependency inventory, and successful native load remain required.

## Staging and activation

Reuse the verified bootstrap installer for a signed target. Do not create a
second extractor or dependency installer. Each version remains immutable under
`<runtime-root>/v<version>/`; a failed update cannot change the active runtime.
The updater holds one cross-process update lease, stages and verifies the new
version, then writes a pending record with the old and new receipt identities.

Automatic means check, stage, and activate without a per-release prompt after the
local operator has enabled an update channel and automatic activation during
installation. That stored policy is the explicit authorization; activation is
not a per-release hard gate. It does not mean interrupting work. Activation
waits until there is no active provider turn, approval, terminal, transfer, or
repository mutation. A continuously busy daemon keeps the verified update
pending and reports why.

Activation needs a stable launcher or service-manager target that is outside the
immutable version directories. The active receipt changes by atomic rename and
directory flush. On the next start, the new daemon must publish a startup receipt
only after it owns the profile, opens and migrates durable state, starts the
listener, and can answer its local health probe. Until that receipt arrives, the
old runtime stays available. A bounded activation watchdog restores the old
active receipt and starts it after failure. A successful startup commits the new
receipt; later application errors do not trigger automatic code rollback.

This activation contract is not implementable uniformly on current main:

- systemd and launchd can restart a managed process, but their exact update exit,
  restart, health, and rollback paths still need native proof;
- the Windows `ONLOGON` task does not restart after the action exits, as measured
  in the S1.1 assessment;
- WSL service selection is not wired into installation, and actual logon
  acceptance remains unproved.

Signed discovery and staging can land before those gaps close. S1.4 cannot be
ticked until every supported managed install can activate or roll back, or the
support matrix explicitly excludes that platform from auto-update.

## Daemon surface and evidence

The daemon owns canonical update state. Protocol additions need strict runtime
schemas and tests for:

- `update.status`: channel, current version, last check, pending version, and a
  bounded refusal or activation state;
- `update.check`: start one deduplicated check and return its observed result;
- `update.activate`: request activation of an already verified pending version,
  subject to the idle boundary and update policy.

`update.status` is available to every authenticated client, including read-only
relay admission. `update.check` and `update.activate` accept only a loopback
connection that completed the local-owner proof, or the daemon's background
updater acting under the stored install policy. Relay-carried connections,
watch-only clients, and paired machine actors refuse both mutating methods. A
manual local activation still respects the idle boundary; it is the operator's
explicit request, not an agent hard-gate approval, and it does not change the
stored policy.

The background scheduler uses the same operation. Timers do not keep a stopped
daemon alive. Network, signature, metadata, install, activation, rollback, and
cleanup failures are distinct and auditable without logging URLs containing
credentials or downloaded bodies.

Tests must include malformed and oversized metadata, every wrong role and
threshold, expired and replayed metadata, root and online-key rotation, hash and
length mismatch, redirect and timeout refusal, concurrent checks, interrupted
staging, idle deferral, activation crash, rollback crash, and a healthy commit.
Failure injection is required for every filesystem and process boundary. Native
tests must prove restart and rollback on each supported service manager.

## Stop point

The signing authority, root threshold and custody decisions are made and recorded
below. Artifact discovery, verification, and staging may now be implemented and
reviewed independently of platform activation. The final S1.4 tick requires both
the reproducible-build comparison and the native activation matrix.

## Maintainer decisions, resolved 2026-09-14

1. **Root threshold and holders: 2 of 3 offline keys.** All three holders are the
   maintainer today, so the threshold buys loss tolerance now and compromise tolerance
   once a second holder exists. A second holder is added by root rotation, not by a new
   root, so no installed daemon has to be re-rooted for it.

2. **Online role custody: a protected GitHub environment, not repository secrets.**
   Targets, snapshot and timestamp keys live in an environment with required review and
   the shortest practical expiry. A protected environment is a GitHub setting, and a
   setting is invisible in a diff, the same class as a required check that nobody made
   required. So the configuration is recorded here, beside the design, and it carries a
   check: a workflow run triggered by a pull request must not be able to reach the
   signing keys. Verified once by attempting it from a pull request run and recording
   the refusal, not inferred from the settings page. The record names the environment,
   the reviewers, the expiry, and the run id of the refused attempt.

3. **Root ceremony: the initial root digest is published beside the bootstrap archive
   digest, on a page the installer did not fetch from the package.** The failure this
   prevents: an installer that trusts the package it just fetched validates an
   attacker's package as readily as ours, because the embedded root came from the same
   source as the bytes it is meant to check. A digest is only worth publishing if it is
   checkable from somewhere the installer did not get from that source. The installer
   docs therefore say compare both digests before running, with the exact commands, or
   the published digest is decoration. The ceremony record names the date, the holders,
   the root digest and where it was published.

4. **Recovery, written before implementation.** An online role key lost or suspected
   compromised: the root threshold signs a new root that rotates that role, and new
   targets, snapshot and timestamp metadata are published under the new key; clients
   follow the rotation by the TUF workflow. A root holder lost: the remaining two sign a
   root rotation that removes the lost key and adds a replacement holder. Two root keys
   lost: the fleet is re-rooted by a new install, which is the case the threshold exists
   to make unlikely and the docs must say so plainly.

Signed off by the maintainer on 2026-09-14. Implementation of discovery, verification
and staging may start; the activation matrix and the reproducible-build comparison remain
the tick's other half.

References:

- [The Update Framework specification](https://theupdateframework.github.io/specification/latest/)
- [TUF JavaScript implementation](https://github.com/theupdateframework/tuf-js)
- [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [GitHub offline attestation verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)
- [npm package provenance](https://docs.npmjs.com/generating-provenance-statements/)
