---
"@getdomovoi/daemon": patch
---

Raise the daemon's MCP SDK floor to 1.31.0. Earlier 1.x versions can send OAuth client credentials
to an authorization server the MCP server chooses (GHSA-6qxp-vccf-f47h, high). The workspace also
forces patched versions through scoped overrides: the MCP SDK reached through the Claude Agent SDK
and the shadcn CLI, `shell-quote` 1.11.0 or newer (GHSA-pqg4-j6r4-53mv, critical) and
`source-map-js` 1.2.2 or newer (GHSA-68fv-2mgg-jv7q, high). `shell-quote` is reached through
`@changesets/cli` and the private mobile app's Expo toolchain, and `source-map-js` through postcss
in tsup and vite; no released package ships either.
