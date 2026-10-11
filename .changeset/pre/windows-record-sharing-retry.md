---
"@getdomovoi/daemon": patch
---

A status read or scan that briefly holds the record open no longer ends Windows supervision. The supervisor retries sharing failures for up to five seconds, then fails closed as before. Stop request and shutdown record writes also retry within the stop operation deadline.
