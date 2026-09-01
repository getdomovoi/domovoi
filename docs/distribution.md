# Distribution contract

Domovoi uses pnpm for repository development. Published JavaScript artifacts remain compatible
with npm and Bun because they use standard package manifests, ESM exports, and declared Node
engine ranges. Consumers do not need pnpm.

## Planned channels

| Channel | Artifact | Source of truth |
| --- | --- | --- |
| npm, pnpm, Bun | `@getdomovoi/protocol`, daemon and CLI packages | signed npm tarballs |
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
document is proven rather than assumed.

The daemon is not part of this check. Its production graph builds native modules, so a cold install
per package manager on every CI run costs far more than it proves; its packaged contents are
covered by `pnpm test:packages`.

## Release artifacts

`pnpm release:artifacts` writes the files a GitHub Release carries into `release/`:

- one npm tarball per publishable package, packed exactly as `pnpm publish` would;
- a CycloneDX 1.6 SBOM beside each tarball, listing every production dependency with its version,
  package URL, and declared license, and recording the tarball's own SHA-256 in the metadata; and
- `SHA256SUMS` over both, in the format `sha256sum -c` and `shasum -a 256 -c` verify.

A dependency that declares no license appears in the SBOM with an empty `licenses` array rather
than an invented one. Today that is the proprietary Claude Code agent SDK described in
[licensing.md](licensing.md), so the SBOM shows the same constraint the license audit records.

The generator runs on Linux in CI so it cannot rot, but nothing publishes yet. Attaching these
files to a GitHub Release is part of the release workflow, which does not exist.

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

The first public alpha is `0.1.0-alpha.1`. Until that release, `pnpm release:version` is run only
deliberately, and no package is published from this repository.

## Immutable workflow references

GitHub Actions are pinned by full commit SHA, with the human-readable tag kept in a trailing
comment. Tags and abbreviated SHAs are mutable references and are rejected by
`pnpm release:invariants`, which reads every workflow in `.github/workflows` and every composite
action in `.github/actions`. Container steps must carry a full `@sha256:` image digest.
