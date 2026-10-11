---
"@getdomovoi/daemon": patch
---

Pager settings (`core.pager`, `pager.*`, `GIT_PAGER`, `PAGER`) no longer make a read-only Git command
from Claude Code ask. Git starts a pager only when its output is a terminal, and Claude Code runs
Bash commands without one. A command that fakes a terminal, such as `script` or `unbuffer`, is not a
listed read and still asks.
