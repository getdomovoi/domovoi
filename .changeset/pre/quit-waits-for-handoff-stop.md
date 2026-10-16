---
"@getdomovoi/desktop": patch
"@getdomovoi/daemon": patch
---

Quitting the desktop while a service handoff is stopping its own daemon now waits for that stop,
so an emergency stop's state save is not cut off. On SIGINT or SIGTERM the daemon is stopped even
when its endpoint file cannot be removed, and each failure is written to stderr.
