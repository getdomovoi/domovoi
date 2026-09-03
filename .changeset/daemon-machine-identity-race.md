---
"@getdomovoi/daemon": patch
---

Publish a machine identity without replacing one won by an overlapping daemon
start, so every concurrent start adopts the same durable machine ID.
