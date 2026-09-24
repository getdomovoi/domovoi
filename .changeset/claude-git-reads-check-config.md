---
"@getdomovoi/daemon": patch
---

A read-only Git command from Claude Code now skips Domovoi's approval only when Git is not configured
to run a program for it. Domovoi reads the worktree's effective Git configuration first (every
scope, includes resolved) and asks instead when it finds an fsmonitor helper, an external diff,
a diff textconv or command, a filter, signature verification or a GPG program, when a
post-index-change hook exists (git status can rewrite the index), or when `GIT_EXTERNAL_DIFF` is
set. A configuration that cannot be read also asks.
