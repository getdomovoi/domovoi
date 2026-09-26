---
"@getdomovoi/daemon": patch
---

A provider disconnect no longer marks a frozen transfer source or an unfinished archive as failed. Those sessions keep their lifecycle and provider thread, so the workspace snapshot stays valid and saves, `system.hello` and `workspace.get` keep working. Any turn or approval they still held on the exited process is cleared, as for other sessions of that provider. The disconnect result is also validated on a copy before it reaches the live workspace. Queued sends it holds are written in one store transaction before anything else changes; if the store refuses one, that send stays as it was and the rest of the disconnect still applies.
