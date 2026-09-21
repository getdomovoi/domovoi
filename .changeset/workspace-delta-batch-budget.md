---
"@getdomovoi/protocol": patch
---

Name the workspace delta batch delay as a performance budget. Terminal output already had a published batch delay, but assistant text deltas had none, so any batching interval would have been a bare number inside the daemon. The budget file now carries `workspaceDelta.batchDelayMilliseconds` and the protocol package exports it as `workspaceDeltaBatchDelayMilliseconds`, so the interval is visible to `pnpm performance:budget` and to every client that needs to reason about it. A test pins the value and pins it at or above the terminal output delay.
