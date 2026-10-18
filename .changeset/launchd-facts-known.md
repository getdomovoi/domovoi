---
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

On macOS the Settings daemon card reads launchd's "never exited" as a known fact and shows "Last exit: none since the service loaded" instead of "Last exit unknown". It no longer shows "Supervisor exhaustion unknown" on macOS: the LaunchAgent's KeepAlive has no restart cap, so launchd never gives up. Linux and Windows still say it is unknown. A locked Install button is drawn unfilled so it no longer reads as live beside "Install is off".
