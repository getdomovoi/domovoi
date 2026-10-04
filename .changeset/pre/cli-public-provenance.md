---
"@getdomovoi/cli": patch
---

Publish the CLI publicly with npm provenance, like the protocol, daemon and credential store. A
`prepack` script builds `dist` before packing, so a tarball can no longer be produced without the
`domovoi` executable its manifest names. The release tooling now packs, describes and orders all
four public packages; the CLI and credential store SBOMs take their inventory from the pnpm lock.
