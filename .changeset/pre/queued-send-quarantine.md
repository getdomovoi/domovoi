---
"@getdomovoi/daemon": patch
---

A queued message the running build cannot read no longer stops the daemon from starting. The row moves to a `queued_session_send_quarantine` table with its bytes and the reason, a `queued-send.quarantine` audit receipt names it, the daemon error log reports it, and the other queued messages still load. Reasons written when a queued message changes state are trimmed and bounded to the 1,024 UTF-16 units the loader accepts. If the database is locked or the move fails, the row is skipped for that load, stays where it is, and the error log says it was not moved; the next load tries again. A new queued message for the same session moves an unreadable row aside before replacing it, and refuses to replace it if the move fails. A row with no session id is moved aside once. The daemon keeps the same bounded reason in memory that it writes to disk.
