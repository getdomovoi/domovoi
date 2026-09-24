---
"@getdomovoi/daemon": patch
---

An audit append at the retention cap no longer walks the cap's worth of index rows to find what to prune. The retained count per class is kept exact (a caller's rollback is detected by checking that the last appended row, matched by sequence, entry id and class, still exists, and the count is then recounted; the sequence alone is not enough, because SQLite reuses a rolled-back sequence), so the prune removes only the oldest rows past the bound, found from the front of the index. Retention is unchanged: each class still holds exactly its bound.
