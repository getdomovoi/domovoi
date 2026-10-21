---
"@getdomovoi/daemon": patch
---

The staged runtime goes into place only after every step that can refuse with nothing changed: on install after the handoff, its profile check and the caller's fence, and the claim of the profile for the service; on update right before the new launch agent or user unit is written (after the bootout and the profile claim on launchd), or first in the swap for WSL. A unit write that fails after it no longer reports that nothing was changed; the previous unit is written back and started.
