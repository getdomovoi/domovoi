---
"@getdomovoi/daemon": patch
---

Keep WSL helper paths and Git arguments literal by bypassing the default Linux shell with --exec. This fixes UNC path translation and prevents shell expansion of arguments. Update the Windows daemon; no re-pairing or protocol change is required.
