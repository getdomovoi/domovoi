---
"@getdomovoi/daemon": patch
---

A Codex session in a repository this machine trusts gets the repository's tool servers when its
thread opens, if the session worktree still has the trusted digest. Codex keeps the project
untrusted and reads no repository file itself: the daemon passes the `mcp_servers` entries of the
digested `.codex/config.toml` in the thread config, with only their command, arguments,
environment, working directory, address, literal headers, timeouts and tool lists, and without
environment keys that steer an agent, its network or the programs it starts. Every passed server is
made to ask before each tool call, and the question comes to Domovoi as an approval card. A server
named like one of the person's own, a plugin's included, one Codex treats as its own, and a remote
server that reads a variable or a program's output into its requests are held back, as are every
other setting, hooks and rules. When Codex's server catalog cannot be read, no repository server
passes. The file refusal is skipped only for a thread opened under a trusted verdict; hooks in a
main checkout still refuse every thread. The refusal text now says how trust changes it.
`tool.inventory` reports a trusted repository's Codex servers as loading exactly when they are
passed.
