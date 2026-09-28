---
"@getdomovoi/daemon": patch
---

Startup now reads the emergency stop journal 16 rows at a time. A group of rows holds only its own
rows and the stops they name. The rows it read, the stops it acted on and the lines it will write go
to the store, in new `emergency_stop_recovery_rows` and `emergency_stop_recovery_lines` tables,
not into a copy of the workspace. The workspace is copied and saved once, after the last group,
with every line, and only then are the finished rows cleared. So what a group holds, and the work
it does, does not grow with the number of stops earlier groups recovered. After the save the
workspace holds the lines, as it holds every line on the thread. Every stop is still finished before
the daemon accepts connections.

A startup that ends before that save leaves in the journal every row it read a stop from, and the
next one reads those rows again. A row from which no stop could be read may already have moved to
`emergency_stop_intent_quarantine`. The store lists the stops a recovery has acted on, in a new
`emergency_stop_recovery` table, until the recovery is done, and a line such a recovery wrote does
not count as the stop's record.

A row can reach the journal behind the groups, or take the place of a row recovery cleared (from
another writer on the store, or a trigger in it). After each save, another round reads every row no
round has read, known by its rowid and content rather than by how many rows are left, and recovery
ends only when a round finds none and emptying the stop list adds none. Past 16 rounds, startup fails
instead of accepting connections;
the rounds so far stay saved, and the next start continues. The error says that if this happens
again, something outside Domovoi is writing to the store, and it needs repair. A row is cleared only
while it is still the row that was read, and each row once. The rows left to clear are found through
a partial index, `emergency_stop_recovery_rows_due`, created on first use, so rows that stay listed
are not read again for each batch.

Going back to a build without emergency stop journal recovery while a stop is pending is not
protected. The desktop 0.0.1 release is such a build: it does not read the journal, so it starts and
accepts connections without applying the pending stop.

Looking up whether a damaged row already has a copy in `emergency_stop_intent_quarantine` now uses
an index on that table, created on first use in a store that lacks it, instead of reading the whole
table for each row. Moving an unreadable row aside, and clearing a finished one, now removes that
row alone. Before, a row stored under a null key took every other row under a null key with it.
