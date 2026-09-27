---
"@getdomovoi/daemon": patch
---

`readDaemonServiceRuntimeVersion` reports a version only when the service definition is exactly what an install writes for a published copy, `<profile>/runtime/<version>/<id>`, under the profile the saved configuration names: the whole launchd plist or systemd unit as Domovoi renders it, or a Windows task with one action whose command and arguments are the install's. `<version>` must pass the check the desktop publishes under. Anything else, a `Program` key, a later `ExecStart` line, a second task action, another profile's runtime or an entry from another copy included, reports installed with no version.
