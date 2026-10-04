---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

Make the protocol package installable from a registry tarball. The manifest now carries top level
`main` and `types` so consumers on the `node10` module resolution can find the declarations, a
`default` export condition so CommonJS and non `import` resolvers reach the same entry, a
`./package.json` subpath, `sideEffects: false`, and the `keywords` and `bugs` metadata a registry
listing needs. A `prepack` script builds `dist` before packing, so a tarball can no longer be
produced without the files its manifest points at.
