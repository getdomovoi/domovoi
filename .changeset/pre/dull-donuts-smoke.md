---
"@getdomovoi/daemon": patch
---

Bound pairing claims per source and listener without resetting on reconnect, and keep rejected pre-authentication traffic in a separate audit retention budget so it cannot evict operator decisions. Throttled claims do not consume a valid pairing code. Existing history remains readable.
