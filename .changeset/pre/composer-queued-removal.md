---
"@getdomovoi/ui": patch
---

Removing a queued turn from the composer now removes it from the queue the parent holds, through `onQueuedChange`, rather than only clearing the composer banner while the turn stayed queued.
