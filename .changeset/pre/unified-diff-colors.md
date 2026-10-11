---
"@getdomovoi/ui": patch
---

Color every line of a unified diff, so a reader sees which way a change went
without counting markers. Additions and removals carry the same treatment the
split view already used. The per-file expansion and the worktree diff share
one renderer.
