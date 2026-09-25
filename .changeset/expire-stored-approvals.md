---
"@getdomovoi/daemon": patch
---

Expire every stored pending approval card when the daemon starts. A stored card's provider request id came from a provider process that is gone, and a new provider process can issue the same id to a live request in another session, so allowing or archiving the stale card could decide that request. The agent asks again if it still needs approval.
