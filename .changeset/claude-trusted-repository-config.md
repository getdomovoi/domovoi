---
"@getdomovoi/daemon": patch
---

A Claude Code session in a repository this machine trusts loads part of the repository's
configuration when it opens, if the session worktree still has the trusted digest. Claude keeps
`settingSources: ["user"]` and reads no repository file itself: the daemon passes hooks of every
event except `PermissionRequest`, `PreToolUse`, `Elicitation` and `ElicitationResult`, the `env`
block without keys that steer Claude, its network or the programs it starts, and deny and ask
rules through the SDK `settings` option, and adds `.mcp.json` servers once Claude has listed the
person's own. A server whose name contains `__`, one whose tool names would read as one of the
person's, a remote server whose address or headers contain `$`, and a server with other fields are
held back, as are allow rules, `defaultMode`,
`additionalDirectories`, plugins, helper commands and every other setting. A running session keeps
what it loaded. `tool.inventory` reports a trusted repository's Claude Code entries as loading
exactly when they load.
