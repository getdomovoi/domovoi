---
"@getdomovoi/ui": patch
---

The mode menu and the fresh session's "What it will do first" card now say what Plan and Ask hold
the provider to, as the daemon configures it. Ask is read-only: Claude, opencode and kilo refuse
edits and shell commands, and Codex runs commands in a read-only sandbox. Plan is Claude's own plan
mode, opencode's and kilo's plan agent with edits and shell refused, or Codex's read-only sandbox.
The old notes said Ask asks before each write and Plan cannot run anything, and neither is true.
Ask no longer shows a checkpoint row, since nothing in it is allowed at a gate.
