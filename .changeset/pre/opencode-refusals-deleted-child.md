---
"@getdomovoi/daemon": patch
---

A subagent refusal that fails after the subagent was deleted is dropped instead of kept for retry,
and a subagent deleted again is remembered as the most recent deletion, so a burst of deletions
cannot make it adoptable again.
