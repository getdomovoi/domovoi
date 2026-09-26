---
"@getdomovoi/daemon": patch
---

Refuse corrupt WSL listings instead of reporting missing distributions. Discovery requires a
valid header and every nonblank row to parse, with no partial results. Both `domovoid wsl list`
and `domovoid open` report the corrupt classification and a diagnostic command to run, without
repeating unreadable row contents. Header-only listings and explicit absence answers still work.
