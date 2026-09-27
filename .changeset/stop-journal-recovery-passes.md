---
"@getdomovoi/daemon": patch
---

Startup now reads the emergency stop journal 16 rows at a time. Each group of rows is finished,
saved and cleared before the next is read, so no more than one group of journal rows is in memory
at once. The workspace still holds every line recovery writes, and each group's save copies it.
Every stop is still finished before the daemon accepts connections.

A startup that ends between two groups no longer loses a later row's effects. The store lists the
stops a recovery has acted on, in a new `emergency_stop_recovery` table, until every group is done,
and a line such a recovery wrote does not count as the stop's record. A row written behind the
groups while they run is read by a further round, and a row that names several stops is cleared
once.

Looking up whether a damaged row already has a copy in `emergency_stop_intent_quarantine` now uses
an index on that table, created on first use in a store that lacks it, instead of reading the whole
table for each row. Moving an unreadable row aside, and clearing a finished one, now removes that
row alone. Before, a row stored under a null key took every other row under a null key with it.
