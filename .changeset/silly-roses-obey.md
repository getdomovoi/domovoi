---
"@getdomovoi/daemon": patch
---

Attempt restore-claim close and removal independently, always clearing the process-local reservation. Report cleanup failures with the claim path while preserving the original restore failure. If restoration already completed, explicitly warn against retrying it.
