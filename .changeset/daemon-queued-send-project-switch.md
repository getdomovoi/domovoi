---
"@getdomovoi/daemon": patch
---

Switching projects after a queued send no longer breaks the daemon. Queued sends load with the project that owns their session, so a send waiting in one project comes back when that project is opened again.
