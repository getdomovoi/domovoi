---
"@getdomovoi/ui": patch
"@getdomovoi/mobile": patch
---

The approval card offers Always only for a request the daemon resolved. A request it could not
resolve, such as a Claude Read, Glob, Grep or Task, a WebFetch or MCP call, a read outside the
worktree or an edit aimed at the worktree root, cannot become a standing rule and the daemon refuses
one, so the desktop and web card, the phone approval screen and the tablet card no longer show the
button there. The desktop and web card also no longer offer Always on a hard gate, which the daemon
refuses too; the phone and tablet already did not. Allow once and Deny are unchanged.
