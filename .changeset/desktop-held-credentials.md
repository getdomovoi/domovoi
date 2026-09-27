---
"@getdomovoi/daemon": patch
"@getdomovoi/desktop": patch
---

`captureInheritedCredentials` takes an optional second argument: values a caller already took out of the process environment and held. They are pinned to the profile exactly as values read from the environment are, and a held value wins over one still there. The desktop app's first module now takes `DOMOVOI_AUTH_TOKEN`, `DOMOVOI_CREDENTIAL_PATH` and `DOMOVOI_RELAY_CREDENTIAL_FILE` out of its environment with its own code, holds them, and hands them to the daemon it loads from its shipped runtime. Limit: the profile they are pinned to is read when the daemon loads, not when the app starts.
