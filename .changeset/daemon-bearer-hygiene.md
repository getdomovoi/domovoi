---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": patch
---

The daemon bearer no longer reaches child processes or borrows a device's name. A daemon started
with `DOMOVOI_AUTH_TOKEN` kept it in its environment, so the Claude Code SDK, OpenCode and Kilo
servers, agent processes and every terminal inherited the credential that resolves approvals. The
daemon now removes `DOMOVOI_AUTH_TOKEN` and `DOMOVOI_CREDENTIAL_PATH` from its own environment once
it has read them.

A connection authenticated with the daemon bearer chose its own audit identity in `system.hello`,
including a paired phone's `device-...` id, so its approvals were recorded under that phone. Such a
hello is now refused, and client audit actors carry `credential: "daemon"` or `"device"`, stored
with the audit entry.
