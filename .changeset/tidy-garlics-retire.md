---
"@getdomovoi/daemon": patch
---

Export a daemon command module that shares service installation, status, and removal with the daemon worker and resolves the packaged worker entry independently of the invoking CLI.

The domovoid service install command now registers the daemon's own dist/index.js, resolved from the module's real location, instead of the path used to start the invoking process in process.argv[1].
