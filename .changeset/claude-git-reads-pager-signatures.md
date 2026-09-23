---
"@getdomovoi/daemon": patch
---

The Git settings check behind Claude Code's read-only Git commands now also asks when `PAGER` or
`GIT_EXEC_PATH` is set, when `format.pretty` or a `pretty.*` format uses a signature placeholder
(`%G?`, `%GG`, `%GS`, `%GK`, `%GF`, `%GP`, `%GT` or `%GR`, which make git log run the signature
program), and it now finds a post-index-change hook under a hooks path that starts with a space.
