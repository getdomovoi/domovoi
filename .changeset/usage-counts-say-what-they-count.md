---
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

Count a Claude turn as every model request it made, subagents included, with
its own cost rather than the query's running cost. A Codex turn still counts
its largest single request and is now recorded as partly reported, so totals
that include one say they may be low. The usage popover reads the session and
today after the turn, so a session total is never below its own turn, and the
chip and rows say what each number counts: context, or the session's running
total.
