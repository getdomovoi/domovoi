---
"@getdomovoi/ui": patch
---

`useWorkspace` returns `connectionId`: the id the daemon's `system.hello` gave the connection open
now, or null while no connection is open or when the hello named none. It changes with every
reconnect.

The stopped notice on web and desktop adds "from this client" to its time line when the daemon's
pause row names this connection. A pause from another connection, or a row an older daemon wrote
without the id, gets no suffix.
