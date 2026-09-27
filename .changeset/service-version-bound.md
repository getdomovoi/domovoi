---
"@getdomovoi/daemon": patch
---

`readDaemonServiceRuntimeVersion` reports a version only when the program the service definition runs is `<profile>/runtime/<version>/node/bin/node` (`node\node.exe` on Windows) under the profile the saved configuration names. Another profile's runtime, a runtime named anywhere else in the definition, or no readable saved configuration reports installed with no version.
