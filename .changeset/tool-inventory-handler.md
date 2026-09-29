---
"@getdomovoi/daemon": patch
---

The daemon now answers `tool.inventory`. It reads the open repository's own Claude Code, Codex,
OpenCode and Kilo configuration with the repository configuration reader, which runs nothing, and
answers with each agent's files and entries, the configuration digest a trust decision will pin
to, and the repository's trust on this machine. There is no trust store yet, so every repository
is reported as not trusted. No entry is marked held back yet, and every agent reports its tool
servers as read from its files, since Domovoi starts none of them with tool servers removed. With
no project open the answer lists no agents. An answer larger than the protocol's byte budget
leaves out entries from the agent listing the most and counts them in that agent's
`omittedEntries`. A reader failure, or an answer the protocol would refuse, is answered with the
daemon's internal error, which names no path or value. Phone and tablet credentials are refused,
as for `skill.inventory`.
