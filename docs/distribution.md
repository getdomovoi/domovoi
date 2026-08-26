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
