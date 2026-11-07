---
"@getdomovoi/daemon": patch
---

Every Codex turn now also carries Domovoi's note about the files the sandbox refuses, as turn
context (`additionalContext`), so a Codex thread started before that note existed learns it after
it is resumed. Codex keeps the note once. A Codex that does not accept the field runs the turn
without it.
