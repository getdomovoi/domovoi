---
"@getdomovoi/daemon": patch
---

The service handoff fence now refuses while an emergency stop runs, with `An emergency stop is
still running.`, until the stop has finished, its state save included. The stop clears turns and
gates before that save, so the fence used to find nothing in flight and could let a service
handoff stop the daemon in the middle of the stop. A stop whose save fails still finishes and
reports the persistence failure; the fence is granted after it. A fence taken before a stop began
stays held through it, as before.

Daemon shutdown now waits for an emergency stop that is still running, its state save included,
before it closes the store. A handoff that stops the daemon under a fence taken before the stop
no longer loses the stop's record.
