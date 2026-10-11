---
"@getdomovoi/ui": patch
---

Open a thread with a scrolling start line instead of a fixed banner

The session header repeated the session title, the absolute worktree path and
the file and test counts above every turn and never scrolled away. v2 names the
session in the command palette pill and opens the conversation with one mono
rule carrying the repository, branch, worktree name and start time. The worktree
action keeps the editor the operator chose and is reached from the command
palette, and a read-only session still says so above the composer.
