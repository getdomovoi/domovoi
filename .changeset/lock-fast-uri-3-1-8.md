---
"@getdomovoi/daemon": patch
---

Lock `fast-uri` 3.1.8 in place of 3.1.6. The daemon reaches it through the MCP SDK, which depends on
`ajv`. Version 3.1.6 carries two high advisories: authority injection through an unvalidated port in
`serialize` (GHSA-qw65-cvwx-89v3), and host confusion through an unclosed bracket in the URI
authority. Only `fast-uri` moves in the lockfile; it has no dependencies of its own.
