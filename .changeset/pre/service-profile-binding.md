---
"@getdomovoi/daemon": patch
"@getdomovoi/desktop": patch
---

The daemon exports `serviceProfileMismatch`, which compares the profile a caller's environment names with the one the saved login service configuration names (or the default profile an install writes). The desktop refuses to install, remove or update the login service when the two differ, because its turn check and fence reach only its own daemon; it says which profiles they are. Update the service now takes the daemon's fence before it copies the runtime under the profile, so no turn starts on a copy that is being replaced.
