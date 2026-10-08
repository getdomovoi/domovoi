---
"@getdomovoi/mobile": patch
---

Read a session's terminals on the phone, Phone v2 frame 04.

The phone lists the open session's terminals (`terminal.list`), again every ten seconds while the
session is open because nothing announces a new one, watches each (`terminal.watch`) and applies
live `terminal.output`, `terminal.closed` and `terminal.ownership`, then unwatches them when the
person leaves the session. The thread shows each terminal's tail with Show all N
lines; the full view names the device that holds the claim, says Live, Failed, Closed or
Unconfirmed, marks where the daemon's record starts and where live output begins, and offers
Follow output and Jump to latest. It is read-only: the phone never types, resizes or claims. The
attach sheet's Terminal output row now says picking output to attach is what is not built.
