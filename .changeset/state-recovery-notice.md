---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": minor
---

Stored state that cannot be read is no longer moved aside silently. The daemon records a `state.quarantine` audit receipt naming the kept file, logs it, and returns an optional `stateRecovery` field on every client `system.hello` result until it restarts. A database moved aside whole keeps its paired devices when its pairing table can still be read. State written by a newer protocol minor is left in place and startup fails with a message naming the file and both versions, so going back to an older build no longer resets the newer build's workspace.
