---
"@getdomovoi/ui": patch
---

The audit log draws each row as the Desktop v2 design does: an outcome dot, a 24-hour time, the
action with an actor pill over its detail, then who acted and the outcome with its target and
session. A row from another day also names the day, because the query has no time window. The
detail is plain text that scrolls inside the row when long, not a code block.

The facts under the log state the daemon's fixed retention counts, 10,000 activity and 1,000
pre-authentication entries, and take the design's dots instead of shield icons. The line beside
Export this query can now say where the file lands for the client kind: a browser client says
saves to this device, a desktop says writes a file on this machine. It reads row or rows by count.
