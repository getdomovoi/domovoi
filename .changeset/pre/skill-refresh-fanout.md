---
"@getdomovoi/ui": patch
---

Refresh the skill catalog only when the machine facts or the project's id, path, or branch change,
cancel the requests a superseded refresh left in flight, and dial fleet inventories through a pool
of four that asks online machines first and stops when the refresh is cancelled. A daemon's late
answer to a cancelled or expired request is dropped instead of being reported as a protocol error.
