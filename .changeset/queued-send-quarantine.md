---
"@getdomovoi/daemon": patch
---

A queued message the running build cannot read no longer stops the daemon from starting. The row moves to a `queued_session_send_quarantine` table with its bytes and the reason, a `queued-send.quarantine` audit receipt names it, the daemon error log reports it, and the other queued messages still load. Reasons written when a queued message changes state are trimmed and bounded to the 1,024 UTF-16 units the loader accepts.
