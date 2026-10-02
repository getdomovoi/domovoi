---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

A `tool.inventory` git filter entry carries `commandHidden: true` exactly when redaction hid part of its command, which then shows the redaction marker. The protocol refuses an entry whose flag and marker disagree. Nobody can review what a hidden command runs, so the daemon records no git filter acknowledgement for a block that holds one, and its filters stay held back under any grant. The trust sheet offers no trust for such a block and says that part of a filter command is hidden. Any redaction counts, a credential alone included: the inventory does not say what was hidden.
