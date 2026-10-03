---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

A `tool.inventory` git filter entry carries `commandInexact: true` exactly when its `command` is not the configured value byte for byte: redaction cut part of it, rewrote it, or the value holds the redaction marker text itself, which cannot be told apart from a cut. The protocol refuses an entry that shows the marker without the flag. A command the redaction would cut nothing from is shown exactly as configured, its patterns and braces unescaped, so it stays reviewable. Nobody can review a command shown other than as Git runs it, so the daemon records no git filter acknowledgement for a block that holds one, and its filters stay held back under any grant. The trust sheet offers no trust for such a block and says that Domovoi cannot show the command exactly as Git runs it. Any cut counts, a credential alone included.
