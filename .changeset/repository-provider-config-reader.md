---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": minor
---

The daemon can read a repository's own Claude Code, OpenCode and Kilo configuration without running
any of it, for the tool inventory and repository trust. It lists the tool servers, hooks, environment
key names, permission rules, helper commands, plugins and skills those files declare, and computes
the configuration digest a trust grant pins to. The scope includes Kilo's `config.json` and the
`tui.json` and `tui.jsonc` plugin files OpenCode and Kilo load. A repository root that is itself a link
is refused like any other link. Every command, rule and name is redacted before it leaves the reader:
each `NAME=value`, each value after a sensitive key, flag or authorization scheme, each header value
after a header flag, every URL path after the host, every URL query and fragment part and URL user
info read `[REDACTED]`, and
environment values are never read. A flag right after an authorization scheme word is hidden whole
once its own value is redacted. A scheme word or key is also read where the protocol's credential
check reads one: after one layer of percent encoding, after backslash and `\u` escapes, among a JSON
argument vector's strings, and before a value that opens with a quote. Text that check would still
refuse is cut before the word it reads there, the rest `[REDACTED]`. Nothing calls the reader yet; the `tool.inventory` handler and the
trust store come later.

The protocol exports the cap on each tool inventory entry text field
(`maximumToolInventoryCommandLength`, `maximumToolInventoryDetailLength`,
`maximumToolInventoryMatcherLength`, `maximumToolInventoryNameLength`,
`maximumToolInventoryHelperNameLength`, `maximumToolInventoryRuleLength` and
`maximumToolInventoryEventLength`), and the inventory schema holds each field to them. The daemon's
reader fits every redacted text to the same constants.
