---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": minor
---

Stored state that cannot be read is no longer moved aside silently. The daemon records a `state.quarantine` audit receipt naming the kept file, logs it, and returns an optional `stateRecovery` field on every client `system.hello` result until it restarts. A database moved aside whole, including one where `PRAGMA quick_check` finds damage in a table other than the workspace, keeps its workspace snapshot and paired devices when they still read and validate. Paired devices receive only whether a recovery happened and what was kept, not the path or the failure text. State written by a newer protocol minor is read through a read-only connection, left byte for byte in place, and startup fails with a message naming the file and both versions, so going back to an older build no longer resets the newer build's workspace.
