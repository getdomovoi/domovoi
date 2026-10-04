---
"@getdomovoi/daemon": patch
"@getdomovoi/desktop": patch
---

The daemon reads which runtime version the login service runs, from the service's own definition. When the desktop cannot talk to the daemon that owns the profile and a login service is installed, the refusal names that version, or says the service is older when the definition does not name one.
