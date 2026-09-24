---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": patch
---

The daemon bearer no longer reaches child processes or borrows a device's name. A daemon started
with `DOMOVOI_AUTH_TOKEN` kept it in its environment, so the Claude Code SDK, OpenCode and Kilo
servers, agent processes and every terminal inherited the credential that resolves approvals. The
daemon now removes `DOMOVOI_AUTH_TOKEN` and `DOMOVOI_CREDENTIAL_PATH` from the process environment
once it has read them, including when the desktop app passes its own environment, and keeps them
in memory so a second start in the same process uses the same bearer and path. The kept values are
pinned to the profile directory that named them (its device and inode), and only a later read of the
process environment for that same profile gets them back. Every acquisition takes them out first,
including one that refuses. `AcquireLocalDaemonOptions` and `ProductionDaemonOptions` take
`environmentOverrides`, settings added on top of the environment, which the desktop uses in
development instead of a copy of its environment. Overrides may not set `DOMOVOI_AUTH_TOKEN`,
`DOMOVOI_CREDENTIAL_PATH` or `DOMOVOI_RELAY_CREDENTIAL_FILE`; an acquisition given such an override
throws before anything starts.

A connection authenticated with the daemon bearer chose its own audit identity in `system.hello`,
including a paired phone's `device-...` id, so its approvals were recorded under that phone. Such a
hello is now refused, and `terminal.create` and `terminal.claim` refuse a request that names a
paired device's id the connection did not authenticate as. Client audit actors carry
`credential: "daemon"` or `"device"`, stored with the audit entry, including on a queued send the
daemon releases later.
