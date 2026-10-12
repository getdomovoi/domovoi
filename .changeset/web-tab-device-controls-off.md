---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

A browser tab no longer offers Rename, Rotate and Unpair (or Revoke, on a machine row) on Machines.
The daemon takes those only with its own credential and closes a connection that sends them with a
device credential, which is all a browser tab holds. Each row now says so in place of its
consequence line, and names the desktop app on that machine as the place to do it.
