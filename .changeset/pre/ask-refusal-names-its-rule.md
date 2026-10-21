---
"@getdomovoi/daemon": patch
---

A Claude Code refusal in Ask mode now names the rule that decided it, the same in the hook text
Claude reads and on the refusal card. A command Domovoi cannot confirm only reads, such as
`touch`, says Ask mode is read-only instead of "Domovoi cannot tell which files this command
reads". A read that would need an approval, outside the session worktree or at a hard gate, says
Ask mode has no approvals, names the path or the gate, and its card names that rule. Every call
refused before is still refused.
