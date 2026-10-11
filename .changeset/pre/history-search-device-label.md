---
"@getdomovoi/daemon": patch
---

`session.history` with a `query` matches an approval entry by the label of the paired device that
decided it, so searching History for `dana` finds what was decided on dana's phone. An entry
without a device (the daemon credential, or a row written before the field) matches as before.
