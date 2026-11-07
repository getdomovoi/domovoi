---
"@getdomovoi/daemon": patch
---

The "Paused by <client>." row that `session.pause` and `system.pauseAll` write now carries the
`connectionId` of the authenticated client connection that asked, and its `clientId` when the
connection has one. The body is unchanged, and a pause asked by no client connection writes neither
field.
