---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": minor
---

Resolve approval redaction against the session's project and hide path facts when its context is missing.

Prepare atomic per-project workspace persistence and validated restoration of all active project rows. Keep single-project storage compatible and refuse unreadable active state without rewriting it.

Allow snapshots to report active projects above a lowered admission cap and mark a project whose folder is missing.
