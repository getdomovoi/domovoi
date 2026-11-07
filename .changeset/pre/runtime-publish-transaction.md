---
"@getdomovoi/daemon": patch
---

`installDaemonService` and `updateDaemonService` take a `staged` runtime with a `publish` step, run once under the service-operation lease after every refusal. The desktop publishes into a fresh directory, so a failure after it leaves the runtime the previous service runs as it was and nothing is put back. An update holds the lease until a publish its deadline gave up on has settled. `readDaemonServiceRuntimeVersion` reads the version from `<profile>/runtime/<version>/<id>/node/bin/node`.
