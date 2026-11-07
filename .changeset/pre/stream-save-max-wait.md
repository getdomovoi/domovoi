---
"@getdomovoi/daemon": patch
---

Save a streaming session at least once a second. The daemon waits for a 32 ms pause in streamed
text before it saves the workspace, so a stream that never paused stayed only in memory until it
ended. A save now also runs 1 s after the first unsaved delta, however fast deltas keep arriving.
Each save still redacts, validates and writes the whole snapshot as before.
