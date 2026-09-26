---
"@getdomovoi/daemon": patch
---

Cursor and Grok sessions are refused in a worktree that holds configuration the agent would load
from the repository itself, in any directory from the session's directory up to the repository
root. Neither agent has a switch that turns project configuration off, and these files can start
programs or change agent permissions. The refusal happens before the agent is asked anything, at
session start, resume and each turn, and names the file: "Cursor would load .cursor/mcp.json from
this worktree, and that file can start programs or change agent permissions. Domovoi does not load
repository-brought configuration until a trust gate ships. Remove .cursor/mcp.json from this
worktree or use another provider here."

- Cursor: `.cursor/mcp.json`, `.cursor/hooks.json`, `.cursor/cli.json`, `.cursor/sandbox.json`,
  `.claude/settings.json` and `.claude/settings.local.json`.
- Grok: `.grok/config.toml`, `.grok/hooks`, `.grok/plugins`, `.grok/agents`, `.grok/roles`,
  `.grok/workflows`, `.grok/lsp.json`, `.grok/sandbox.toml`, `.mcp.json`, `.cursor/mcp.json`,
  `.cursor/hooks.json`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/agents`,
  `.claude/plugins` and `.envrc`.

A symbolic link counts as the file. Instruction files such as `AGENTS.md` and `CLAUDE.md`, rules,
skills and commands do not stop a session. The daemon README's "Repository configuration" section
now also describes the Codex refusal.
