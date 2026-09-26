---
"@getdomovoi/daemon": patch
---

Resuming an OpenCode or Kilo session is refused when its history pages repeat a cursor, since the
pages then cannot be shown to cover the history, and a full page that comes back without a cursor
is followed by one read of the whole history before the next message id is chosen.
