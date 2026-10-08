---
"@getdomovoi/desktop": patch
---

The CLI the app ships beside the daemon keeps only its own dependencies, not a second copy of the
daemon or the packages only that copy needs. `domovoi daemon install` through the linked `domovoi`
runs the runtime's own daemon, which copies the runtime out of the app before registering it.
