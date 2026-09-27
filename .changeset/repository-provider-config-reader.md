---
"@getdomovoi/daemon": patch
---

The daemon can read a repository's own Claude Code, OpenCode and Kilo configuration without running
any of it, for the tool inventory and repository trust. It lists the tool servers, hooks, environment
key names, permission rules, helper commands, plugins and skills those files declare, and computes
the configuration digest a trust grant pins to. Every command, rule and name is redacted before it
leaves the reader: each `NAME=value`, each value after a sensitive key, flag or authorization scheme,
URL query values and URL user info read `[REDACTED]`, and environment values are never read. Nothing
calls the reader yet; the `tool.inventory` handler and the trust store come later.
