---
"@getdomovoi/daemon": patch
---

A plan file the artifact watcher found in the worktree is no longer removed when the working plan
changes, and comments on it stay on it. Before, every plan edit, provider plan update and turn
boundary edit read the file's artifact as an old turn-scoped working plan, folded it into the working
plan and moved its comments there; the file came back only after it changed on disk. Turn-scoped
working plans from older profiles are still folded into the working plan.
