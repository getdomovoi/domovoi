---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

Refuse WSL facts on any platform but linux. A heartbeat or enrollment
descriptor that claims a distribution for a `win32` or `darwin` daemon is
refused as an invalid descriptor instead of being shown as a WSL machine.
