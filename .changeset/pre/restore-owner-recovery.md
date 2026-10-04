---
"@getdomovoi/daemon": patch
---

Recover abandoned transfer restore claims only after the owner has exited and
every Git command has a recorded, uninterrupted settlement. Preserve claims when
descendant liveness is unknown, including after command cancellation or a missing
exit record. Keep exclusion through command close and delayed claim cleanup;
refuse legacy or incomplete ownership records explicitly.
