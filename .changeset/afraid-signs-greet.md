---
"@getdomovoi/daemon": patch
---

Resolve approval redaction against the session's project and hide path facts when its context is missing.

Prepare atomic per-project workspace persistence and validated restoration of all active project rows. Keep single-project storage compatible and refuse unreadable active state without rewriting it.
