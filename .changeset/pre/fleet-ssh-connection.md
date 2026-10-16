---
"@getdomovoi/daemon": patch
---

A machine reached over SSH now reads as SSH in the fleet, even when an older direct route is still remembered. That direct route is kept, with the time it last answered, and is tried first on the next attempt.
