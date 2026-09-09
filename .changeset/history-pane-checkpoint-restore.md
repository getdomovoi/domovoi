---
"@getdomovoi/ui": minor
---

Offer checkpoint restore from the history pane. The thread and the pane share one CheckpointRestore control for the confirmation copy, and one shell-owned guard for the in-flight state, so a restore started from either surface holds the other shut until it answers.
