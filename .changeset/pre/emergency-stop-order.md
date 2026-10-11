---
"@getdomovoi/daemon": patch
---

`system.emergencyStop` now broadcasts `system.emergencyStopped` before the idle workspace snapshot that reflects it, so a client holding a queued message sees the stop before the session goes idle and does not send the message that would restart the stopped work. While a stop is in progress, workspace snapshots and deltas that other changes would broadcast are held; the stop notice goes out first and one snapshot then carries every change. The client that made a change still gets the new state in its own reply.
