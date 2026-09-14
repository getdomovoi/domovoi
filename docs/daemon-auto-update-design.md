# Daemon auto-update design

Status: design for S1.4. Signing authority and key custody require the S0.7/S4.1
maintainer decision before implementation can claim a production trust root.

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

This is the only option here that directly specifies root rotation, threshold
trust, key compromise recovery, rollback refusal, mix-and-match refusal, and
expiration for freeze detection. Use a conforming library rather than a local
signature composition. The current `tuf-js` main branch requires newer Node 22
patch releases than Domovoi's declared `>=22.13.0`; selecting a library version
must either preserve the supported floor or deliberately raise it.

Maintainer decisions:

1. Root threshold and holders. Recommendation: 2 of 3 offline keys held in
   separate hardware-backed or encrypted offline custody.
2. Online role custody. Recommendation: separate targets, snapshot, and
   timestamp keys in a protected GitHub environment, with the shortest practical
   expiry and required review. They are not repository secrets available to pull
   requests.
3. Initial trusted root bytes and the ceremony that records their digest.
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

Automatic means check and stage without a per-release prompt after the operator
has enabled an update channel. It does not mean interrupting work. Activation
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

Choose the signing authority, root threshold and custody before implementation
adds production trust bytes or signing workflow permissions. Artifact discovery,
verification, and staging may then be implemented and reviewed independently of
platform activation. The final S1.4 tick requires both the reproducible-build
comparison and the native activation matrix.

References:

- [The Update Framework specification](https://theupdateframework.github.io/specification/latest/)
- [TUF JavaScript implementation](https://github.com/theupdateframework/tuf-js)
- [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [GitHub offline attestation verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)
- [npm package provenance](https://docs.npmjs.com/generating-provenance-statements/)
