---
"@getdomovoi/daemon": patch
---

When the Codex app-server dies partway through a line of output, the error shown is again its exit
code and the reason it printed on stderr (for example that the sign-in expired), not "emitted invalid
JSONL" for the leftover fragment.
