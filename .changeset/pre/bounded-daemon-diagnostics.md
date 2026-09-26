---
"@getdomovoi/daemon": patch
---

Retain production daemon diagnostics in five local JSONL files of at most 1 MiB
each. Redact and bound records before writing, preserve limits across restart,
and report file failures through stderr while keeping existing error delivery.
