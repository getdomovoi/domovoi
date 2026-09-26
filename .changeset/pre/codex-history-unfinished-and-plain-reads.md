---
"@getdomovoi/daemon": patch
---

When the Codex notice's repository-history scan fails, times out or reaches its bound, the notice
now says "Domovoi could not finish checking the repository history." instead of listing nothing.
`pwd` and a plain `echo` (no redirect to a file, no substitution) join the Claude Code reads that
skip Domovoi's approval.
