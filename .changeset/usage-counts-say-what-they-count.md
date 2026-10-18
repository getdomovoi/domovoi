---
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

Count a turn's usage as every model request it made. A Codex turn counted only
its largest request, and a Claude turn took the query's running cost as its own.
The usage popover reads the session and today after the turn, so a session
total is never below its own turn, and the chip and rows say what each number
counts: context, or the session's running total.
