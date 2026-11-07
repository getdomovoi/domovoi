---
"@getdomovoi/credential-store": minor
"@getdomovoi/desktop": patch
---

`publishFileDurably(staging, path)` renames a flushed staging file into place and flushes its directory, so the rename survives power loss on POSIX. The desktop's relay pin file publishes through it.
