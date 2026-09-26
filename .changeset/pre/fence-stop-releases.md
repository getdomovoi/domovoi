---
"@getdomovoi/daemon": patch
---

An emergency stop now fences two handlers that had already passed its checks. A queued message released at a turn boundary carries the stop's cancellation into its `session.send`, so a stop that lands while the provider starts the turn leaves the message held instead of delivered and the session without the new turn. An `approval.resolve` that is reading package scripts checks again after that read and refuses when the stop has already denied and removed the approval, so the agent is not told "allow" after the stop's "deny".
