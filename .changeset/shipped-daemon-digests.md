---
"@getdomovoi/desktop": patch
---

A packaged app imports its daemon only when the daemon's dist and node_modules resolve inside its own resources and every file in dist matches the sha256 digests packaging recorded in app.asar. Otherwise startup stops with Domovoi could not start, naming the file. The held credentials are handed over only after that check.
