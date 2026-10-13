# Release reproducibility

Publication requires two independent clean builds of the same source commit. The
release workflow runs matrix slots `a` and `b` on separate `ubuntu-24.04` jobs,
with Node `22.23.3` and the exact pnpm version in `package.json`. Neither producer
restores a dependency or build cache. A later job compares both candidates before
preparing the publish plan. The publisher downloads and verifies that compared
release; it does not rebuild the packages.

## Compared files

The comparison covers exactly ten files, without normalizing their contents:

- npm archives for `@getdomovoi/protocol`, `@getdomovoi/credential-store`,
  `@getdomovoi/daemon` and `@getdomovoi/cli`;
- one CycloneDX SBOM for each of those four packages;
- `domovoi-web-<version>.tar.gz`;
- `SHA256SUMS`, which hashes the preceding nine files.

Before hashing, the builder sorts only the CLI manifest's top-level dependency
maps. pnpm 11.5.3 rewrites its three workspace links in varying key order. The
builder preserves conditional exports/imports order and all other tar entry
headers, modes and payload bytes, then emits deterministic gzip bytes. The
protocol and credential store have no workspace links; the daemon has at most one
per dependency map.
Their archives remain untouched, including the protocol bytes embedded and pinned
inside the daemon. The strict CLI transformation accepts bounded regular-file
USTAR output and refuses unsupported entry forms. Any future nondeterminism
elsewhere still fails the comparison. The comparator itself never normalizes or
excludes bytes.

There are no signing envelopes in this inventory and no excluded bytes. Native
installer signatures, notarization tickets and platform packages are outside this
release path. Adding them requires a separately reviewed comparison scope; an
unsigned result here is not native signing or activation qualification.

A candidate also contains `build.json`. Its producer identity deliberately differs
between the builds, so the receipts are validated rather than compared byte for
byte. `publish-plan.json`, `pack/` and `release.json` are created only after a
successful comparison. They are not independent build outputs.

## Build and evidence contract

Run the producer script from its own fresh checkout:

```sh
node scripts/release-reproducibility.mjs build a local-comparison-id
```

Use slot `b` and the same comparison ID in a second fresh checkout at the same
commit. Each invocation refuses tracked changes, untracked files and ignored
outputs, including an existing dependency tree. It creates its own temporary pnpm
home, store, cache, state and XDG configuration directories. It supplies an empty
user auth file, disables the side-effects cache and global virtual store, and
checks pnpm's observed configuration before installing with the frozen lockfile.
The producer does not use credentials from the invoking environment. It reads no
real daemon profile and starts no service.

The existing packer runs inside each checkout. Passing two directory arguments to
one imported packer would not be equivalent: package packing resolves the
packer's own module checkout. After installation and packing, the producer checks
that HEAD, its tree, tracked content and explicit input digests remain unchanged.

Each receipt records:

- the full source commit and Git tree identity;
- SHA256 digests of `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and
  `.github/workflows/release.yml`;
- the release version, observed exact Node and pnpm versions, Node component
  versions, operating-system family and architecture;
- fixed `TZ=UTC`, `LC_ALL=C` and `SOURCE_DATE_EPOCH` from the source commit;
- the local or GitHub run ID, matrix slot and a distinct workspace identifier;
- each artifact's exact name, byte count and SHA256 digest.

The full Git tree binds the remaining tracked build sources. The trusted producer
captures that tree; the offline verifier does not reconstruct a Git repository or
authenticate a claimed tree from downloaded JSON. Dependencies are selected by the
frozen lockfile. Matching records describe the observed toolchain and platform;
they do not prove equivalence across different platforms or compiler toolchains.

Compare completed candidates from a checkout of that source:

```sh
GITHUB_SHA=<full-source-commit> node scripts/release-reproducibility.mjs compare /path/to/a/release /path/to/b/release
```

The destination `release/` must not already exist. The comparator checks strict
receipt schemas, distinct producers, matching input/toolchain records, all ten
regular files, their recorded digests, and byte-for-byte equality. Missing files,
extra candidate files, symlinks, changed inputs or mismatches refuse the operation.
Only validated bytes are copied to the new destination. A failed write may leave
an incomplete destination; it is never valid publication evidence or silently
overwritten on retry.

`reproducibility.json` contains both build receipts and their common artifact
inventory. Both `release:prepare` and `release:verify` revalidate those records
against the expected commit, current explicit source inputs and actual canonical
artifact bytes. `release.json` includes the comparison file's digest separately.
It is not inserted into `SHA256SUMS`, avoiding a circular digest dependency.
Changesets publishes copies of these verified archives, and the canonical GitHub
release includes the comparison file through the normal release-file inventory.

## Trust and failure boundaries

These JSON files are unsigned evidence. Digest consistency cannot authenticate a
publisher or stop a malicious party who can replace both artifacts and evidence.
Independent execution is established by the reviewed workflow and its separate
jobs, not by two self-declared workspace IDs. Distribution consumers still need
their independently trusted checksum or signed metadata. This feature does not
supply that trust anchor or authorize publication.

Producer execution is supported on POSIX hosts because bounded shutdown uses an
owned process group. The release jobs run on Linux. Comparison and evidence
validation do not require POSIX process control. A producer has a 20-minute total
budget and a separate 30-second cleanup budget. Commands have bounded output; a
nonzero exit or deadline refuses the build. Owned descendants must stop before
cache removal. If exit cannot be confirmed, the operation fails and names the
retained isolation directory. Filesystem operations cannot be preempted by a
JavaScript timer; a timeout is a refusal boundary, not a hard operating-system
completion guarantee. Successful output directories remain for comparison.

Unit tests use synthetic archives to exercise refusal, publication gates and
process ownership. The clean-checkout execution test uses real pnpm installation
with an empty synthetic workspace; it does not substitute for building the real
product twice. Actual comparison results must name their source commit and
platform. Local successful comparison is local evidence, not a hosted release run,
a native service test, a signature attestation or a publication result.

The exact Node pin is listed in the [official release index](https://nodejs.org/dist/index.json).
The [pnpm auth configuration](https://github.com/pnpm/pnpm/blob/main/pnpm/docs/npmrc.md)
describes the isolated XDG configuration and user auth-file override.
