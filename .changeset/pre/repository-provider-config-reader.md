---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": minor
---

The daemon can read a repository's own Claude Code, OpenCode and Kilo configuration without running
any of it, for the tool inventory and repository trust. It lists the tool servers, hooks, environment
key names, permission rules, helper commands, plugins and skills those files declare, and computes
the configuration digest a trust grant pins to. The scope includes Kilo's `config.json` and the
`tui.json` and `tui.jsonc` plugin files OpenCode and Kilo load. A repository root that is itself a link
is refused like any other link. Every command, rule and name is redacted before it leaves the reader,
and environment values are never read. Each text is cut before its first trigger and ends in
`[REDACTED]`: an authorization scheme word, a sensitive key or flag, an assignment, a header flag
(`-H`, `--header`, `--proxy-header`), URL user info, or any credential shape the protocol's check
knows. The reader looks for a trigger in every form that check reads: as written, quoted strings
included; after one layer of percent encoding; after backslash and `\u` escapes; as the shell's
words; and among a JSON argument vector's strings. Each of those readings is taken again of every
form another makes, until no new form appears. Text whose forms still change after six readings or
64 forms is cut after its program name, or reads `[REDACTED]` alone. A command given as an argument
vector is cut at whole arguments. Before the cut, a URL keeps its scheme and host, and its path and every query and
fragment value read `[REDACTED]`. The protocol's check then judges each text once; one it would still
refuse is cut after its program name, or reads `[REDACTED]` alone. Nothing calls the reader yet; the
`tool.inventory` handler and the trust store come later.

The protocol exports the cap on each tool inventory entry text field
(`maximumToolInventoryCommandLength`, `maximumToolInventoryDetailLength`,
`maximumToolInventoryMatcherLength`, `maximumToolInventoryNameLength`,
`maximumToolInventoryHelperNameLength`, `maximumToolInventoryRuleLength` and
`maximumToolInventoryEventLength`), and the inventory schema holds each field to them. The daemon's
reader fits every redacted text to the same constants. It also exports its credential check
(`holdsCredential`), the rules that check reads (`credentialRules`: scheme words, sensitive key
parts, whole-name keys, pointer suffixes and token prefixes, frozen), `isCredentialKey` and
`credentialShapeAt`, which finds the first credential shape in work that grows linearly with the
text. The daemon's reader takes its rules from these rather than a copy.
