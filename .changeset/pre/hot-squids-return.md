---
"@getdomovoi/daemon": minor
"@getdomovoi/protocol": minor
"@getdomovoi/ui": patch
---

Add retained rule revocation, persisted use counts and renderable hard-gate categories for the Rules tab.

The wire protocol moves to 0.7.0. Update clients and daemons together: a peer on another minor version is refused at `system.hello` with `-32012`.
