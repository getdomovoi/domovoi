---
"@getdomovoi/daemon": patch
---

`readDaemonServiceRuntimeVersion` reports a version only when the service definition runs `<profile>/runtime/<version>/<id>/node/bin/node` (`node\node.exe` on Windows) with `<profile>/runtime/<version>/<id>/daemon/dist/index.js` from the same copy, under the profile the saved configuration names, and `<version>` passes the check the desktop publishes under. Another profile's runtime, an entry from another copy, a runtime named anywhere else in the definition, or no readable saved configuration reports installed with no version.
