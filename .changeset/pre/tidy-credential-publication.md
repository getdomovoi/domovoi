---
"@getdomovoi/daemon": patch
---

Publish file-backed root credentials and local owner challenge keys only after their private
staging bytes are synced and closed. A killed first initializer no longer leaves an empty
authoritative file, and concurrent initializers reuse the winning credential without replacement.
Initialization is bounded by the remaining startup deadline and requires hard-link support.
Existing malformed files remain untouched; startup names an explicit offline quarantine remedy.
