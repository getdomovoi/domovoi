---
"@getdomovoi/daemon": patch
---

A daemon that finds workspace state written by a newer protocol minor now refuses it and does not
start. Until now it moved that state aside into a snapshot JSON file and started from the seed, so
running an older build once, then the newer one again, lost the active workspace. The stored state
is left exactly as it is, and the refusal names the path and both protocol versions. State from
this version, or a patch ahead of it, opens as before.
