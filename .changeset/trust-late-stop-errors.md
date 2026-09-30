---
"@getdomovoi/daemon": patch
---

A failure while the daemon records a provider stop or a grant-carrying call, after trust was
taken back, is now reported through the daemon's error log instead of an unobserved promise
rejection. The thread's pending-work count still ends, so a later revoke can release it. A failure
before the stop's timeout fails the stop and fences the thread, as any failed stop does.
