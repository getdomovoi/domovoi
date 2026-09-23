---
"@getdomovoi/daemon": patch
---

`system.emergencyStop` now broadcasts `system.emergencyStopped` before the idle workspace snapshot that reflects it, so a client holding a queued message sees the stop before the session goes idle and does not send the message that would restart the stopped work.
