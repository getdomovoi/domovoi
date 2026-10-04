---
"@getdomovoi/daemon": patch
---

Claude Code's read-only Bash commands now skip Domovoi's approval only when they are `cat`, `head`,
`tail`, `wc`, `ls` without `-R`, or a Git read that prints no file content, and only when every
argument is a path Domovoi can see before the command runs. Any other read, such as `grep -R`,
`find -exec`, a glob or a pipe into `xargs`, now raises an approval card in Plan and Build and is
refused in Ask, because it can reach files outside the worktree that are only known at run time.
