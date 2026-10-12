---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

Machines no longer sends a request from a browser tab that the daemon refuses for that tab's
credential and answers by closing the connection. In any browser tab, Pair a machine and Forget
are off: fleet.enroll and fleet.forget need the daemon's own credential. In a phone or tablet
tab, Authorize this client and Terminal are off too: fleet.clientRoute and terminal.create are
not open to a phone or tablet credential. Each locked control says why and names the desktop app
as the place to do it. The desktop app is unchanged.
