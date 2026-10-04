---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": minor
---

Keep healthy fleet machines readable when another stored machine row is malformed. Retain the damaged row in quarantine with an atomic, sanitized audit receipt, and exclude it from dialing and heartbeat updates.

Add opt-in quarantine diagnostics to `fleet.list` with typed operator remedies. Existing list calls, lifecycle replies, and notifications retain their wire shape. UI rendering is unchanged. Forget or explicitly enroll a peer again when its identity is valid; invalid identities require offline registry repair.
