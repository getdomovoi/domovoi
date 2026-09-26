---
"@getdomovoi/daemon": patch
---

Attempt restore-claim close and removal independently, always clearing the process-local reservation. Verify a unique ownership token before removing a claim, preserving an observed replacement and naming its ownership change. Report cleanup failures with the claim path while preserving the original restore failure. If restoration already completed, explicitly warn against retrying it. Manual claim removal still requires stopped daemons because token verification and unlink are not atomic.
