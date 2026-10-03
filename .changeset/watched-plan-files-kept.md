---
"@getdomovoi/daemon": patch
---

A plan file the artifact watcher found in the worktree is no longer removed when the working plan
changes, and comments on it stay on it. Before, every plan edit, provider plan update, turn boundary
edit, streamed plan text and finished Plan mode plan read the file's artifact as an old turn-scoped
working plan, folded it into the working plan and moved its comments there; the file came back only
after it changed on disk. Turn-scoped working plans from older profiles are still folded into the
working plan. A saved working plan that kept a plan file's path from that fold is taken over as the
working plan and loses the path, so a session never holds two working plans with the same id.
