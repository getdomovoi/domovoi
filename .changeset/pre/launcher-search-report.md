---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

When every harness is missing, Start a session shows a search report instead of a status list: what the daemon looked for, the PATH it searched, and that finding nothing there is not proof nothing is installed. The daemon reports the searched PATH on the machine (machine.toolPath), and a missing harness reads Not found rather than Not installed everywhere.
