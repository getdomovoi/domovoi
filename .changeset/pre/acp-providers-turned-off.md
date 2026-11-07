---
"@getdomovoi/daemon": patch
---

Cursor and Grok are turned off until the trust gate ships. Both load MCP servers, hooks and
permission rules from the repository they work in, and neither can be told not to, so the daemon no
longer runs `agent`, `cursor-agent` or `grok` for any reason: not to detect them, list their models,
or start or resume a session.

Provider discovery reports both as unable to start, with the reason "Cursor is turned off in
Domovoi for now. Cursor loads MCP servers, hooks and permission rules from the repository it works
in, and Domovoi does not load repository-brought configuration until a trust gate ships." (and the
same for Grok). Runtime discovery reports that the daemon has no session adapter for them, and a new
session or a switch onto them is refused with that reason.

Continuing a stored Cursor or Grok session is refused with "This session uses Cursor, which is
turned off in Domovoi for now. Cursor loads MCP servers, hooks and permission rules from the
repository it works in, and Domovoi does not load repository-brought configuration until a trust
gate ships. The worktree and conversation are kept." A request that finds no adapter for its
provider now returns that provider's reason instead of an internal error.
