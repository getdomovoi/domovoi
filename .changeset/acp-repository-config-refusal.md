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
  `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`.
- Grok: `.grok/config.toml`, `.grok/hooks`, `.grok/plugins`, `.grok/agents`, `.grok/roles`,
  `.grok/workflows`, `.grok/lsp.json`, `.grok/sandbox.toml`, `.mcp.json`, `.cursor/mcp.json`,
  `.cursor/hooks.json`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/agents`,
  `.claude/plugins` and `.envrc`.

A symbolic link counts as the file, and so does a link on the way to it. A session directory reached
through a link is checked at the path given and at its resolved path, for Codex too, and a directory
in no repository is checked up to the filesystem root, except the home directory.

While a session is open its directories are watched. When a listed file appears, the agent process
is stopped, which ends every Cursor or Grok session it runs with the refusal as the disconnect
reason; a session in that worktree is refused when it resumes. The agent process now starts in an
empty private folder instead of the daemon's working directory, and each session's worktree reaches
it as the ACP session directory.

Instruction files such as `AGENTS.md` and `CLAUDE.md`, rules,
skills and commands do not stop a session. The daemon README's "Repository configuration" section
now also describes the Codex refusal.
