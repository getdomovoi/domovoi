---
"@getdomovoi/daemon": patch
---

With no saved service configuration, the launchd check reads the services block of `launchctl print gui/<uid>` line by line, label last, so an extra column no longer hides a `sh.domovoi.*` job. A listing it cannot read refuses the install or removal: `launchd listed the jobs in gui/<uid> in a form this app cannot read, so whether a login service is registered there is not known. Nothing was changed.`
