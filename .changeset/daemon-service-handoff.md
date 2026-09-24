---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
"@getdomovoi/desktop": patch
---

The desktop can install the daemon as a login service from Settings and remove it again. The app copies the runtime it ships under the profile, asks the daemon's own installer to register the service pointing at that copy, and only then stops its in-app daemon and attaches to the service. The switch refuses while a turn runs or a gate waits and names the sessions; a runtime the app does not ship is reported without touching anything.

Install and Remove both wait while a turn runs or a gate waits. The desktop main process checks this too, before anything is stopped: it reads the workspace from its own daemon (`readLocalServiceHandoffRefusal` in `@getdomovoi/daemon`) and applies the same check the window uses (`serviceHandoffRefusal` in `@getdomovoi/protocol`). A workspace it cannot read also makes the switch wait. While the service takes over the profile or gives it back, a window reconnect waits for the handoff instead of starting a daemon inside the app. The runtime copy is made in a fresh directory and renamed into place, so no file from an earlier copy of the same version survives. Settings says when the service was installed but this window could not reach it, when the daemon inside the app stopped and did not start again, and what to run when a removal leaves the profile owner unresolved.
