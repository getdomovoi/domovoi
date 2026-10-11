---
"@getdomovoi/daemon": patch
---

Startup reads and migrates the stored workspace once instead of twice: the first `load()` takes the snapshot the store constructor already migrated. Opening a project no longer reads and migrates the whole current workspace just to learn this machine's record; the daemon passes the machine it already holds.
