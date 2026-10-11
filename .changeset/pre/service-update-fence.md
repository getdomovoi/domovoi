---
"@getdomovoi/desktop": patch
---

Update the service now takes the daemon's handoff fence right before the service restarts, as install and remove do, so no turn starts after the check. It reports success only when the daemon this window reaches is one started outside any app and the service reads back installed and running; otherwise it says `Updated, but this window could not reach the daemon` with `The daemon this window reached is not the running service.`
