---
"@getdomovoi/desktop": patch
---

A packaged app checks every file of the daemon it ships, dist and node_modules alike, against the sha256 digests packaging recorded in app.asar, and loads the daemon from a private copy of the bytes it checked, removed when the app exits. A changed or extra file stops startup with Domovoi could not start, naming it.
