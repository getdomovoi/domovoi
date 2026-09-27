---
"@getdomovoi/desktop": patch
---

The desktop keeps the previous copy of the runtime version aside when it publishes, puts it back when the service call reverts, and drops it only after the call succeeded. The private staging directory is pinned when it is made and removed only while it is still that directory.
