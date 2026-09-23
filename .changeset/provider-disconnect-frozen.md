---
"@getdomovoi/daemon": patch
---

A provider disconnect no longer marks a frozen transfer source or an unfinished archive as failed. Those sessions keep their lifecycle, so the workspace snapshot stays valid and saves, `system.hello` and `workspace.get` keep working. The disconnect result is also validated on a copy before it reaches the live workspace.
