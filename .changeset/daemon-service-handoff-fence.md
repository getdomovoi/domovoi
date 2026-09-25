---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
"@getdomovoi/desktop": patch
---

The switch to or from the login service is now held by the daemon itself. `system.serviceHandoffFence` (loopback, daemon credential only) answers the same refusal as the window's check, or, when nothing runs, no dispatch is in flight and no gate waits, admits no new turn until the connection that took it closes. The desktop takes it right before it stops the daemon inside the app or removes the service, so a turn that starts after the first check makes the switch wait instead of being stopped.

Staging the shipped runtime refuses an app version that is not one release version, a `~/.domovoi` or `~/.domovoi/runtime` that is a link, a shipped part that is not a regular file, and a link that leads outside the shipped runtime, all before any byte is copied. Links inside the runtime are copied as they are. An earlier copy of the same version is moved aside and put back if the new copy cannot be renamed into place.

After a failed install or removal the desktop reads the service back and reports it, along with the daemon it reaches afterwards, including one this app did not start. Settings no longer says nothing was installed or removed unless the read-back shows it. States without approved copy carry a "[Copy pending]" marker.
