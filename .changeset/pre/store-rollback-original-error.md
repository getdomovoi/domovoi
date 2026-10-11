---
"@getdomovoi/daemon": patch
---

When SQLite ends a store transaction on its own, as it does when the database is full, saving a transferred session and holding queued sends now report the error that ended it. Before, the rollback that followed failed with "no transaction is active", and that message replaced the real cause. If that happens while phone pairings are being copied out of a database moved aside at startup, the daemon now starts and its recovery notice says the pairings were not kept, instead of failing to start.
