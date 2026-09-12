---
"@getdomovoi/daemon": patch
---

Recover interrupted session creation and checkpoint forks from durable intent.
Preserve unfinished work without replaying provider setup. Expose a recovered
worktree only after its completion receipt, repository, branch, and HEAD verify;
otherwise retain its location for inspection. Keep intent through failed or late
cleanup until worktree removal settles or a session snapshot commits.
