---
"@getdomovoi/desktop": patch
"@getdomovoi/daemon": patch
---

The desktop copies the shipped runtime under the selected profile, `<profile>/runtime/<version>` (`~/.domovoi/runtime/<version>` for the default profile), so a service change that is then refused replaces at most its own profile's copy. A refused install or removal of a login service whose profile is not known reads as a refusal. `readDaemonServiceRuntimeVersion` reads the version from that layout under any profile.
