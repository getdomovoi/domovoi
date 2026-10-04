---
"@getdomovoi/daemon": patch
---

A stored Cursor or Grok session can now be switched to another provider while both are turned off.
The switch starts a new thread with the chosen provider and no longer tries to stop a Cursor or Grok
thread, since the daemon runs neither. Continuing such a session is refused with "This session uses
Cursor, which is turned off in Domovoi for now. Cursor loads MCP servers, hooks and permission rules
from the repository it works in, and Domovoi does not load repository-brought configuration until a
trust gate ships. The worktree and conversation are kept. Switch this session to another provider to
continue." (and the same for Grok).
