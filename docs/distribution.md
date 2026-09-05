# Distribution contract

Domovoi uses pnpm for repository development. The protocol library supports npm, pnpm, and Bun
through standard package manifests and ESM exports. Consumers do not need pnpm.

The supported frozen daemon installation is the verified bootstrap below. Manual npm, pnpm, or
Bun adds of `@getdomovoi/daemon` are not frozen: selecting the daemon version does not freeze its
transitive dependencies. Bootstrap uses the npm bundled with Node regardless of the package
manager used for a person's other projects. This freezes the reviewed package graph, not native
compilation or the external toolchain.

## Planned channels

| Channel | Artifact | Source of truth |
| --- | --- | --- |
| npm, pnpm, Bun | `@getdomovoi/protocol` | signed npm tarballs |
| verified bootstrap | frozen daemon and CLI runtime | caller-pinned release archive and embedded integrity lock |
| Homebrew | `domovoi` CLI and `domovoid` service formulae | GitHub release checksums |
| AUR | source and binary packages | GitHub release checksums |
| Windows | signed installer and package-manager manifest | GitHub release artifacts |
| macOS | signed and notarized desktop app | GitHub release artifacts |
| Linux | AppImage or native bundle plus daemon package | GitHub release artifacts |

Package managers wrap the same versioned release artifacts. Formulae and manifests must not build
from a moving branch or run an unpinned install script. Release automation will publish npm first,
attach checksummed binaries, then update downstream package manifests.

## Verifying the published artifact

`pnpm test:install` packs `@getdomovoi/protocol` exactly as `pnpm publish` would, then installs the
resulting tarball into a throwaway project with npm, pnpm, and Bun in turn and imports it. The
import is a real one: it reads `protocolVersion` and parses a value through a published schema, so
a package that resolves but cannot be imported fails the check.

Outside CI a package manager that is not installed is skipped and named in the output. In CI a
missing package manager is a failure, because that is where the distribution contract in this
document is proven rather than assumed. The Bun version CI installs is pinned by `bun-version` in
`.github/workflows/ci.yml` and must be bumped by hand; Dependabot moves the action SHA but not that
input.

The daemon is not part of the three-manager import check. `pnpm test:packages` checks its real
packed contents and exercises the bootstrap CLI over HTTPS against an isolated fixture registry.
It installs the same archive into fresh private trees before and after a transitive release
changes, requires the pinned version both times, checks that the permitted build actually ran,
and refuses replaced tarball bytes without publishing an installation. It does not cold-build
every production native dependency on every CI run.

### Verified bootstrap installation

`node scripts/bootstrap-daemon.mjs <version> <baseUrl> <destination> <expectedSha256>` installs an
exact release for Linux, macOS, or Windows. It requires Node 22 or newer with bundled npm 10.0.0
or newer, `tar`, registry access, and the host's native build toolchain. Missing or older npm is
refused with that minimum and the remedy to install a supported Node distribution including npm.
Bootstrap invokes npm through the same Node executable, not a different manager on PATH.

Both the release's `SHA256SUMS` and the SHA-256 supplied by the caller must agree with the archive
bytes. Obtain the script and expected digest through a trusted release channel. A checksum from
the same compromised source as the archive is not independent authentication. Signature
verification remains a separate release item.

The daemon's prepack hook converts the reviewed `pnpm-lock.yaml` production graph into a
lockfile-v3 integrity lock at `runtime/lock.json`, with its install manifest at
`runtime/package.json`. These non-special names survive package-manager packing. Packaging
refuses stale workspace importers, missing SHA-512 integrity, unknown workspace links, or an
unsupported dependency source instead of resolving newer registry metadata. Every supported
platform's optional packages remain in the lock. The archive also contains the exact same-release
protocol tarball at `runtime/protocol.tgz`, bound by SHA-512 in the lock. No provider SDK is
bundled: those bytes are fetched from the registry under their existing terms.

After archive verification, installation proceeds in a separate private `.runtime-*` directory:

1. Reject unsafe paths, duplicate entries, links, and special files before extraction.
2. Check the install manifest and protocol bytes against the lock, then materialise the exact
   lock bytes as `package-lock.json` at the private install root.
3. Run `npm ci --omit=dev --ignore-scripts`, then verify physical package names, versions,
   dependency resolution, required platform packages, and npm's fetched-integrity records
   against the lock. Additional or missing packages refuse publication.
4. Run only the reviewed `node-pty` native build, with its exact-version build permission, then
   verify again and require that npm left the input lock byte-identical. Other dependency
   lifecycle hooks require an explicit policy change and are refused.
5. Publish `v<version>/runtime.json` with a no-replace hard link only after verification. The
   receipt names that private installation, the release digest, and the lock digest.

The JSON result includes `runtimePath`; `node <runtimePath>/dist/index.js` runs the installed
daemon. Bootstrap does not start it, change PATH, configure daemon state, or install supervision.
Private runtime staging is owner-only on POSIX; on Windows bootstrap applies a protected ACL
granting the current user before extraction and installation. Elevated administrators and code
already running as that user are outside this filesystem boundary.

An identical repeat checks the existing receipt and installed graph without rerunning npm.
Concurrent identical installers converge on the first verified receipt and discard only their
own unpublished tree. Drift refuses rather than repairing a possibly running installation. npm
checks downloaded tarball integrity; the later graph check is not a hash of every extracted file
and does not protect against arbitrary modification by the OS user after installation.

#### Download publication and resource bounds

Each invocation streams the archive into a unique private `.bootstrap-*` directory beside the
destination, hashing and enforcing the byte ceiling as chunks arrive. Staging contains unverified
bytes until both checksums pass. It is fsynced and closed before publication, then published with a
hard link that cannot replace an existing path. POSIX staging directories and files are owner-only;
Windows inherits the destination's access controls, so choose a destination writable only by the
installing user. Concurrent
invocations with the same digest may both succeed. Different digests refuse
without replacing the first archive. An existing archive is accepted only after a bounded,
streamed read verifies its length and digest; a symlink or other non-file destination is refused.
The filesystem must support hard links. Unsupported publication fails rather than falling back to
a replacing rename or a copy that another process could read while incomplete.

The archive ceiling remains 256 MiB by default. `SHA256SUMS` has its own 256 KiB byte ceiling and
is the only accumulated download. Archive memory follows individual network chunks and the file
writer, not the total archive size; final verification reads in 64 KiB chunks. This is not a fixed
RSS limit on Node or its transport buffers. The regression measures retained download buffers in
an isolated process, including the staging-to-publication boundary, and separately checks that
each chunk reaches disk before the next read.

One five-minute deadline starts before the npm version probe and covers connection setup,
redirects, body reads, staging, fsync, extraction, npm installation, the native build, graph
verification, and receipt publication. Archive publication gets at most 30 seconds and
only the remainder of that original budget. Embedded calls
can set initial budgets with positive integer `timeoutMs` and `publicationTimeoutMs`;
redirects, trickling bodies, and phase changes never renew the total. Fetch receives the same abort
signal, abandoned bodies are cancelled, and late results cannot begin another step. Cancellation
notifications do not wait beyond expiry for an uncooperative transport to finish closing.
A timed-out filesystem request may still complete at the OS. The error therefore says to inspect
the destination before retrying, not that no file was written. npm receives the abort signal and
its process is killed on expiry; a toolchain child may outlive it, but cannot cause a later
bootstrap step or receipt publication. Removing the current unpublished `.runtime-*` staging,
including its `node_modules` and `.npm-cache`, runs after any failure or expiry under its own
fresh 30-second budget, never the exhausted one, so retries do not accumulate staging trees.
Embedded calls can set it with `cleanupTimeoutMs`. A removal that outlives that budget is not
awaited further; the error names the retained directory.
File flush is not a guarantee of directory-entry durability across a power loss.

Cleanup removes only the current invocation's unpublished staging, never the published archive,
the winning installation, or an older shared `.partial` file. If installation fails, a verified
archive can remain without a runtime receipt. If cleanup fails, the error names retained staging.
An interrupted process can leave `.bootstrap-*` or `.runtime-*` directories. Stop bootstrap and
any remaining build processes before inspecting or removing an exact unpublished directory by
hand. Do not remove a directory referenced by `runtime.json` while its daemon is running. No
age-based cleanup runs automatically. A conflicting archive or installation requires an explicit
operator decision or a different destination; bootstrap never replaces it for the caller.

#### What freezing does not promise

Manual npm, pnpm, or Bun adds of the daemon do not use this controlled install root and are not
frozen. A nested shrinkwrap is not a portable substitute: the manager probe observed both npm 12
and pnpm resolving a newer transitive version; npm 12 no longer uses `npm-shrinkwrap.json`, as
recorded in the [npm 12 breaking changes](https://github.com/npm/cli/blob/latest/CHANGELOG.md#1200-2026-07-08). The
same lock bytes materialised as root `package-lock.json` kept the pinned version with `npm ci`.
Bun was unavailable in that probe, so no Bun shrinkwrap behavior was established. The protocol
library keeps its independent three-manager installation contract.

Native compilation and the external toolchain remain reproducibility limits. Node, npm, the OS,
compiler, Python, system libraries, and any downloaded native build inputs are not frozen by the
package graph. Neither are separately installed provider CLIs or provider services. This is not
a bit-for-bit reproducible binary, an offline installation, or an authenticity guarantee for
third-party code. Registry unavailability, native build failures, and verification failures
refuse publication rather than choosing substitute dependencies.

### Verified bootstrap download

`node scripts/bootstrap-daemon.mjs <version> <baseUrl> <destination> <expectedSha256>` downloads
an archive for an exact version. Both the release's `SHA256SUMS` and the SHA-256 supplied by the
caller must agree with the downloaded bytes. This remains a downloader, not an installer: it does
not unpack the archive, resolve dependencies, configure PATH, or install a service.

Each invocation streams the archive into a unique private `.bootstrap-*` directory beside the
destination, hashing and enforcing the byte ceiling as chunks arrive. Staging contains unverified
bytes until both checksums pass. It is fsynced and closed before publication, then published with a
hard link that cannot replace an existing path. POSIX staging directories and files are owner-only;
Windows inherits the destination's access controls, so choose a destination writable only by the
installing user. Concurrent
invocations with the same digest may both succeed. Different digests refuse
without replacing the first archive. An existing archive is accepted only after a bounded,
streamed read verifies its length and digest; a symlink or other non-file destination is refused.
The filesystem must support hard links. Unsupported publication fails rather than falling back to
a replacing rename or a copy that another process could read while incomplete.

The archive ceiling remains 256 MiB by default. `SHA256SUMS` has its own 256 KiB byte ceiling and
is the only accumulated download. Archive memory follows individual network chunks and the file
writer, not the total archive size; final verification reads in 64 KiB chunks. This is not a fixed
RSS limit on Node or its transport buffers. The regression measures retained download buffers in
an isolated process, including the staging-to-publication boundary, and separately checks that
each chunk reaches disk before the next read.

One five-minute deadline starts before fetching the manifest and covers connection setup,
redirects, body reads, staging, fsync, publication, verification, and cleanup. After staging,
publication gets at most 30 seconds and only the remainder of that original budget. Embedded calls
can set initial budgets with positive integer `timeoutMs` and `publicationTimeoutMs`;
redirects, trickling bodies, and phase changes never renew the total. Fetch receives the same abort
signal, abandoned bodies are cancelled, and late results cannot begin another step. Cancellation
notifications do not wait beyond expiry for an uncooperative transport to finish closing.
A timed-out filesystem request may still complete at the OS. The error therefore says to inspect
the archive before retrying, not that no file was written. No additional cleanup budget is granted
after expiry; the current private staging directory may remain and is named when known.
File flush is not a guarantee of directory-entry durability across a power loss.

Cleanup removes only the current invocation's staging file and directory, never the published
archive or an older shared `.partial` file. If cleanup fails after verification, the error names
the verified archive separately from the retained staging. An interrupted process may leave a
`.bootstrap-*` directory. Stop all bootstrap invocations before inspecting or removing that exact
directory by hand. No age-based or recursive cleanup runs automatically. A conflicting archive
also requires an explicit operator decision or a different destination; bootstrap never replaces
it for the caller.

## Release artifacts

`pnpm release:artifacts` writes the files a GitHub Release carries into `release/`:

- one npm tarball per publishable package, packed exactly as `pnpm publish` would;
- a CycloneDX 1.6 SBOM beside each tarball, listing every production dependency with its version,
  package URL, and declared license, and recording the tarball's own SHA-256 in the metadata; and
- `SHA256SUMS` over both, in the format `sha256sum -c` and `shasum -a 256 -c` verify.

A dependency that declares no license appears in the SBOM with an empty `licenses` array rather
than an invented one. Today that is the proprietary Claude Code agent SDK described in
[licensing.md](licensing.md), so the SBOM shows the same constraint the license audit records.

The generator runs on Linux in CI so it cannot rot. The release workflow below packs the same
tarballs for publishing, refuses to continue if their checksums differ from `SHA256SUMS`, and
attaches all three kinds of file to the GitHub release of each published package.

## Versioning and release metadata

Every package in this workspace carries the same version and is released as one compatibility
unit. `packages/protocol`, `apps/daemon` and its `domovoid` CLI, `packages/ui`, `apps/web`, and
`apps/desktop` ship a matched daemon and client pair, so a version that moves for one of them
moves for all of them. Changesets enforces that at version time through the `@getdomovoi/*` fixed
group in `.changeset/config.json`, and `pnpm release:invariants` fails the build if a manifest
drifts out of lockstep.

Release metadata travels with the change that needs it:

```bash
pnpm changeset
```

Choose the packages the change affects and the bump it deserves. Because the group is fixed, the
recorded bump applies to every workspace package. `pnpm release:status` reports which changed
packages still lack metadata; `pnpm release:version` consumes the accumulated changesets, writes
changelogs, and rewrites the manifests.

The first public alpha is `0.1.0-alpha.0`, because Changesets pre-release mode numbers from zero and the workflow does not set versions by hand. Until the release workflow is enabled,
`pnpm release:version` is run only deliberately, and no package is published from this repository.

## Release workflow

`.github/workflows/release.yml` turns accumulated changesets into a versioned, published release.
It is inert: every job is gated on the repository variable `RELEASE_PUBLISHING` being `enabled`,
and that variable does not exist yet. A push to `main` or a manual dispatch before a maintainer
sets it produces a skipped run and nothing else. The variable, rather than a branch or a secret,
is the switch because it is visible in repository settings, needs no code change to flip in
either direction, and cannot be set from a pull request.

Once enabled, every push to `main` runs the workflow, which does one of three things:

1. **Version.** Pending changesets exist, so `changesets/action/version` runs `changeset version`
   and opens or refreshes a pull request titled `chore(release): version packages` that rewrites
   every manifest to the next version and writes the changelogs. Because the `@getdomovoi/*`
   group is fixed, the protocol, daemon, shared UI, web, and desktop packages all move together.
   Merging that pull request is the release decision.
2. **Publish.** No changesets are pending and a workspace version is missing from the registry,
   which is the state of `main` right after the version pull request merges. The workflow
   publishes and creates one GitHub release per published package.
3. **Nothing.** No changesets are pending and every version is already on the registry.

The mode is chosen by `changesets/action/select-mode` at the end of the `verify` job, and
`verify` runs the same commands as `ci.yml` first: lint, typecheck, tests, build, performance
budgets, `pnpm release:invariants`, the license audit, and `pnpm test:install`. A release cannot
ship a commit that CI would have refused, even if the version pull request merged without a CI
run of its own.

### Publish order

`@getdomovoi/daemon` depends on `@getdomovoi/protocol` through `workspace:*`, which `pnpm pack`
rewrites to the exact release version. A consumer installing the daemon therefore resolves the
protocol at that exact version, so the protocol has to be on the registry first.

The `pack` job writes the publish plan with `changeset publish-plan`, which orders packages by
dependency, and then `pnpm release:order` fails the job unless the plan places the protocol in
an earlier chunk than the daemon. `scripts/publish-order.mjs` reads the same ordered package list
`scripts/release-artifacts.mjs` uses, so there is one place that says what this repository
publishes and in which order. The plan is then packed into tarballs, checked against
`SHA256SUMS`, and handed to the `publish` job as a workflow artifact. `changeset publish
--from-pack-dir` publishes those exact bytes, one plan chunk at a time, and creates the git tags
and GitHub releases from the commit that built them.

### Trusted publishing

There is no `NPM_TOKEN` and the workflow does not accept one. The `publish` job requests
`id-token: write`, and pnpm exchanges the GitHub OIDC token for a short-lived npm credential
scoped to this repository and workflow. npm records the workflow run as the publisher and
generates a provenance attestation; both packages also declare `publishConfig.provenance`, so a
publish that cannot produce an attestation fails instead of shipping unattested. The job runs in
the `npm` GitHub environment so that the trusted publisher on npm can be bound to that
environment name and so a maintainer can require a reviewer before the job starts.

The `publish` job installs with `--ignore-scripts` and downloads the packed artifact instead of
building, so the job that holds the OIDC token runs as little third-party code as possible.

### Enabling the first release

These steps are for a maintainer with owner rights on the GitHub repository and the npm
organisation. None of them has been done, and whether the `getdomovoi` npm organisation name
is available has not been checked.

1. Create the `getdomovoi` organisation on npmjs.com and give it a maintainer with two-factor
   authentication enabled.
2. Configure a trusted publisher for each of `@getdomovoi/protocol` and `@getdomovoi/daemon`:
   publisher GitHub Actions, organisation `getdomovoi`, repository `domovoi`, workflow filename
   `release.yml`, environment name `npm`. If npm requires a package to exist before a trusted
   publisher can be added, publish the first version of each package from a maintainer machine
   with a short-lived granular access token, in the order protocol then daemon, and revoke the
   token afterwards; every later version goes through the workflow. Then set each package's
   publishing access to the strictest setting that still allows trusted publishing.
3. In the GitHub repository, under Settings, Actions, General, allow GitHub Actions to create
   and approve pull requests. The version job cannot open the release pull request without it.
4. Under Settings, Environments, create `npm`. Add the maintainers as required reviewers if a
   human approval should stand between a merged version pull request and the registry.
5. Open a pull request that runs `pnpm changeset pre enter alpha` and commits
   `.changeset/pre.json`, so the first version pull request produces an alpha rather than
   `0.1.0`. Leave pre mode with `pnpm changeset pre exit` when the first stable release is due.
6. Under Settings, Secrets and variables, Actions, Variables, add `RELEASE_PUBLISHING` with the
   value `enabled`. The next push to `main`, or a manual dispatch of the `release` workflow,
   opens the version pull request from the pending changesets.
7. Review and merge the version pull request. The pull request is opened with the workflow's
   own token, so GitHub does not start `ci` on it; the release workflow's `verify` job runs the
   full suite on the merged commit before anything publishes. Close and reopen the pull request
   to run `ci` on it as well, or configure a GitHub App token for the version job later.

To pause releases, delete the variable or set it to any other value. Runs already in progress
finish; the concurrency group prevents two releases from overlapping.

## Immutable workflow references

GitHub Actions are pinned by full commit SHA, with the human-readable tag kept in a trailing
comment. Tags and abbreviated SHAs are mutable references and are rejected by
`pnpm release:invariants`, which reads every workflow in `.github/workflows` and every composite
action in `.github/actions`. Container steps must carry a full `@sha256:` image digest.

## Workspace overrides

`pnpm-workspace.yaml` overrides `esbuild` to `0.28.2` for the whole workspace, so every consumer
shares one copy. Two consumers declare ranges that exclude it: `electron-vite@5.0.0` wants
`^0.25.11` and `tsup@8.5.1` wants `^0.27.0`, and `tsup` builds the `dist/` that the publishable
packages ship. esbuild is pre-1.0, so a minor is a breaking change by its own versioning, and a
toolchain failure after a dependency bump should be checked against this pin first. Remove the
override once both `electron-vite` and `tsup` declare ranges that include `0.28`, then run
`pnpm install --lockfile-only` so `pnpm-lock.yaml` drops the recorded override.
