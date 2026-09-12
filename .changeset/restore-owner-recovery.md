---
"@getdomovoi/daemon": patch
---

Recover abandoned transfer restore claims only after their recorded owner and Git
children have exited. Preserve exclusion while aborted commands or claim cleanup
are still settling, and refuse legacy or incomplete ownership records explicitly.
