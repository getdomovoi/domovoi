---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

Approval cards carry optional attribution for the client that started their turn and a realpath-aware outside-project fact relative to the session worktree. Each containment value names its path or working-directory basis; working-directory containment does not restrict a command's reach. Working-directory facts require a directory reported for that specific command. Reloaded cards omit working-directory containment because their saved directory is display text, not the original request evidence. Unknown facts stay absent, including on older saved cards, and phone and tablet snapshots retain the facts.

Export `approvalPlanStep` to derive a current 1-based step and total from the session plan's approval blocker without storing a stale step number on the card.
