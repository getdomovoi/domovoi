---
"@getdomovoi/daemon": patch
"@getdomovoi/desktop": patch
---

The desktop now removes daemon runtime copies no login service uses. Each install or update publishes the runtime into a fresh `<profile>/runtime/<version>/<id>`, about 150 MB, and until now nothing removed the earlier ones or the copy a failed change left. Once an install or update has confirmed its new service, the desktop asks the daemon (`removeUnusedDaemonRuntimes`) to remove the copies under that profile that neither the service definition nor the one before the change names.

The removal runs under the service-operation lease and reads the definition again there. It removes nothing when the lease is busy, when the definition no longer names the copy this change published, when the previous definition named something other than a published copy, or when a definition or the saved configuration cannot be read. Only `<version>/<id>` directories reached through real directories are candidates; links are never followed or removed. Paths are compared by file identity, and each candidate is renamed to a private name and removed only if it is still the directory that was checked. `readDaemonServiceRuntimeCopy` reads which copy the service runs, and throws rather than read a failed query as no service. A copy a failed change leaves stays until the next confirmed one. Nothing new is shown in the app.
