---
"@getdomovoi/daemon": patch
---

Prevent concurrent verified bootstrap downloads from replacing each other's archive bytes. Each
download uses private staging and atomic no-replace publication. Matching existing archives are
verified and reused; conflicting archives are retained and refused. Publication and cleanup share
one bounded deadline, and cleanup failures name both the archive outcome and retained staging.
The bootstrap script still downloads only; it does not install or supervise the daemon.
