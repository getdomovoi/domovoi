---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

The browser limits dialog inside a session names the route the session is on now. When a reconnect changes the route, or the daemon is lost, the open dialog's rows change with the machine chip. They read "the route" when the route is unresolved or unproved.

The command palette opened over the limits closes them. When it closes, focus goes back to the control that first opened the limits, not to the document body.

An Escape pressed just after the palette hands over to the limits, or just after the palette opens over them, now reaches the dialog that has focus. A dialog that is still closing no longer takes it.
