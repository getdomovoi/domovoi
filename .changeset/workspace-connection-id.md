---
"@getdomovoi/ui": patch
---

`useWorkspace` returns `connectionId`: the id the daemon's `system.hello` gave the connection open
now, or null while no connection is open or when the hello named none. It changes with every
reconnect.
