---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

An approval card's `toolServer` fact can name a server without the file that declared it. The
daemon names a server as the agent names it when it did not read that server's configuration, so
`transport`, `source` and `file` are optional; a file still needs its source.
