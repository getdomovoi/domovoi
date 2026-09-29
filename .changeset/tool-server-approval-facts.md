---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

An approval card names the tool server behind a call to a tool server's tool, and the daemon
refuses Always for any such card before it reads the card's execution record. Claude MCP tools are
named from `mcp__<server>__<tool>`. Codex MCP tool calls, which Codex asks about with an MCP
elicitation, now raise an approval card; the answer never asks Codex to remember it. An ACP tool
call is a shell command only when its kind is `execute`. An OpenCode or Kilo permission is a shell
command only for `bash` with its command; an edit of one file is the Edit file tool on that file,
so Always still makes a file rule; any other permission is the provider's tool, which cannot become
a standing rule.

The protocol's `toolServer` fact can name a server without the file that declared it: the daemon
names a server as the agent names it when it did not read that server's configuration, so
`transport`, `source` and `file` are optional, and a file still needs its source.
