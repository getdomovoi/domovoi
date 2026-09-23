---
"@getdomovoi/daemon": patch
---

Creating a session no longer runs code the repository brings. Claude Code sessions loaded the
worktree's project and local settings, so a tracked `.claude/settings.json` hook, `env` block or
helper command and every `.mcp.json` server ran with no approval card, in every mode including
Ask. OpenCode and Kilo loaded project configuration, plugins and MCP entries for the worktree and
ran a package install in its `.opencode` directories.

Until a repository trust step exists, Claude Code sessions start with only user settings, and the
OpenCode and Kilo servers start with project configuration switched off. Instruction files still
reach the agent: the daemon reads `CLAUDE.md` (with its `@path` imports inside the worktree),
`.claude/CLAUDE.md` and `CLAUDE.local.md` for Claude Code, and the first of `AGENTS.md`,
`CLAUDE.md` and `CONTEXT.md` for OpenCode and Kilo, and passes them as system prompt text. Project
skills, subagents and commands under `.claude/` are not loaded for Claude Code sessions.

Kilo 7.7.6 is the exception: it reads `.kilo/mcp.json`, `.kilocode/mcp.json` and `.kilocodemodes`
from the worktree even with project configuration switched off, starts the MCP servers they list
and loads their agents, with no approval card. The daemon cannot hold these back. A session that
starts, is handed off or is forked to Kilo in a worktree with one of these files now shows a
thread notice that names them.
