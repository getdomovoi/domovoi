---
"@getdomovoi/daemon": patch
---

The Codex notice's repository-history scan now runs only when the worktree's Git settings could not
run a program (the same check that gates Claude Code's Git reads), and it runs with repository hooks
and fsmonitor switched off, no `ext::` transport, and lazy fetching disabled. A partial clone or a
program-running setting makes the notice say "Domovoi could not finish checking the repository
history." instead of running the scan.
