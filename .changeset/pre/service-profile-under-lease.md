---
"@getdomovoi/daemon": patch
---

`installDaemonService`, `updateDaemonService` and `removeDaemonService` take the caller's daemon environment. Given it, each checks the saved service's profile against the profile it names under the service-operation lease, before the handoff or any manager action, and throws `ServiceProfileMismatchError` when they differ. `serviceProfileMismatch` now reads only a missing `service.json` as none saved; one that cannot be reached throws. With none saved, any profile matches, since an install writes the caller's profile.
