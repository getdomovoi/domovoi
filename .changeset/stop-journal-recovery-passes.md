---
"@getdomovoi/daemon": patch
---

Startup now reads the emergency stop journal 16 rows at a time. Each group of rows is finished,
saved and cleared before the next is read, so a journal of any length holds one group in memory.
Every stop is still finished before the daemon accepts connections.

Looking up whether a damaged row already has a copy in `emergency_stop_intent_quarantine` now uses
an index on that table, created on first use in a store that lacks it, instead of reading the whole
table for each row. Moving an unreadable row aside, and clearing a finished one, now removes that
row alone. Before, a row stored under a null key took every other row under a null key with it.
