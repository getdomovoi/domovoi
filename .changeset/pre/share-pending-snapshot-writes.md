---
"@getdomovoi/daemon": patch
---

Workspace snapshot writes that arrive while one is still waiting to start now share that write, since each write carries the whole live snapshot as it stands when it starts. The backlog is at most one running and one pending write, so a burst of provider events or RPCs no longer queues one whole-snapshot write each and delays tool rows and approval cards behind them.
