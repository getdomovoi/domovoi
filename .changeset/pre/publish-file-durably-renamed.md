---
"@getdomovoi/credential-store": minor
---

`publishFileDurably` takes an optional third argument, a callback it runs once the rename is done and before the directory is flushed. A caller that owned the staging file by its name learns that it no longer does, even when the flush then fails. Callers that pass two arguments behave as before.
