---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/cli": patch
"@getdomovoi/desktop": patch
---

Patch three high advisories in shipped dependencies. Electron moves from 44.4.5 to 44.9.1, which
removes trust in the compromised eMudhra intermediate certificates (GHSA-jr5w-w6x2-84p9). The zod
floor moves from 4.6.5 to 4.6.6, which bounds memory use when validating oversized constrained
collections (GHSA-mrhx-c7xc-m3w5). The daemon's MCP SDK now resolves body-parser 2.4.0, which
refuses trailing bytes after a compressed request body (GHSA-27r3-jxmh-p828).

Development tooling also resolves patched happy-dom, undici, systeminformation and node-forge. No
released package depends on those. shadcn moves from 4.21 to 4.23 so its CLI no longer pulls zod 3.
The shared stylesheet imports `shadcn/tailwind.css`, so it picks up 4.23's reduced-motion rule for
the `shimmer` utility, which turns its animation off; no Domovoi element uses that utility.
