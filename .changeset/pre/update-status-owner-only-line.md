---
"@getdomovoi/ui": patch
---

When the daemon refuses update status with `localOwnerRequiredErrorCode`, About
this build keeps the connection and adds one line: "No update status: the daemon
answers it only over loopback, to its owner's credential." Other failures add
nothing, as before.
