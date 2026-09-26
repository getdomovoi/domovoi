---
"@getdomovoi/daemon": patch
---

The instruction files Domovoi reads for a session no longer follow an `@path` import found in
Markdown code (double-backtick and multiline code spans, fences indented up to three spaces, fences
left open, and indented code blocks), and never read a file inside Git metadata or inside a nested
repository or submodule, including through a symlink at the worktree root.
