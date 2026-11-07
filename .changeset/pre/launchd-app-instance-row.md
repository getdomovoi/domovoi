---
"@getdomovoi/daemon": patch
---

Installing or removing the login service from the macOS app no longer refuses because the app is
open. While Domovoi runs, macOS lists the app itself in `launchctl print gui/<uid>` as
`application.sh.domovoi.desktop.<digits>.<digits>`. The check for a Domovoi launch agent with no
saved configuration read that row as ambiguous and refused with "launchd listed the jobs in
gui/<uid> in a form this app cannot read". That exact row is now skipped as the running app. Any
other row that names Domovoi outside `sh.domovoi.*`, including an application row for another
bundle id, still refuses.
