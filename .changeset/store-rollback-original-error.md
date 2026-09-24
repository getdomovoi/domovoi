---
"@getdomovoi/daemon": patch
---

When SQLite ends a store transaction on its own, as it does when the database is full, saving a transferred session and holding queued sends now report the error that ended it. Before, the rollback that followed failed with "no transaction is active", and that message replaced the real cause.
