---
"@getdomovoi/daemon": patch
---

Kilo is turned off. Kilo's embedded server can switch on a rule that allows every tool, and it sends
Domovoi no event when that happens, so Domovoi cannot show an approval card before a tool runs.
Provider discovery now reports Kilo as unable to start without running `kilo`, no Kilo server is
started, and creating a Kilo session or switching a session onto Kilo is refused with "Kilo is
turned off in Domovoi for now. Kilo's server can switch on a rule that allows every tool, and it
sends Domovoi no event when that happens, so Domovoi cannot show an approval card before a tool
runs." Continuing a stored Kilo session is refused with the same reason, and the refusal says the
worktree and conversation are kept and that the session can be switched to another provider.
Cursor and Grok stay turned off under their own switch.
