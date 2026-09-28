---
"@getdomovoi/daemon": patch
---

The daemon's repository configuration reader now reads a repository's own Codex configuration
without running any of it, for the tool inventory and repository trust. It reads
`.codex/config.toml` as TOML data, `.codex/hooks.json`, and the skill folders `.codex/skills` and
`.agents/skills`, and counts `.codex/rules` in the configuration digest. It lists MCP servers
(a local server's command, redacted, and the names of the variables it receives; a remote
server's host and the names of the variables whose values Codex sends it, never an inline token
or header), each server's header helper command and tool approval modes, hooks from both files,
the names of the variables set for the agent's commands (never their values), the approval,
sandbox and shell environment settings, plugins, and skills. Keys Codex ignores in a project
file, such as `notify` and model providers, are not listed, and like every byte of the file
they are in the digest. Only the repository root's `.codex` folder is read. TOML nested more
than 64 levels deep, or that does not parse, is reported unreadable with the reason
`invalid-toml`. The TOML parser is smol-toml, which reads the document as data and runs nothing
from it.
