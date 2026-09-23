---
"@getdomovoi/daemon": patch
---

Switching projects after a queued send no longer breaks the daemon. Queued sends load with the project that owns their session. A send still waiting when a switch interrupts its turn is held, so it is never released on a later, unrelated turn.
