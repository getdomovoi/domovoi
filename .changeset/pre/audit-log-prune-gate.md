---
"@getdomovoi/daemon": patch
---

The audit log prunes only when its per-class row count says the cap is reached, instead of walking the index to the cap on every append. Retention is unchanged: the prune itself still deletes by position, so a count left high by a caller's rolled-back transaction deletes nothing and is recounted.
