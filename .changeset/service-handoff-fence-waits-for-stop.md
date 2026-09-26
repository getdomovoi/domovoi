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

An emergency stop now writes a durable intent to the daemon's store before it acts, and clears it
once its state is saved. If the process ends before that save (a crash, a kill, a quit deadline),
the next start on the same store records `Emergency stop requested by <client>.` on each session
the stop touched before it accepts any connection. Startup recovery already ends the interrupted
turns and expires the waiting gates. A start whose save of that record fails does not open.

A stop finished at restart now leaves each session as a completed stop leaves it: a dispatch the
stop caught in flight has its provider thread reset and its session marked failed. A journal row
that does not read back no longer keeps the daemon from starting: it is moved whole to a separate
table, reported once, and the readable stops are still finished.
