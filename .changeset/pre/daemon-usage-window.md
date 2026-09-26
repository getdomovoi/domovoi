---
"@getdomovoi/daemon": minor
---

Stamp each usage row with the time its turn was first recorded and answer
`usage.window` with one query over the ledger. Rows recorded before the stamp
existed and rows imported by a session transfer carry no time, so they never
count toward a window; rows a transferred or archived session left behind keep
counting. Costs in more than one currency within a window are not combined.
