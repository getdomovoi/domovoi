---
"@getdomovoi/daemon": patch
---

Domovoi retries its initial Windows supervisor process identity query once if the helper reaches its 20 s cap at logon, keeping the same cap for the retry. If the retry fails, startup reports that no daemon was launched and the logon task starts the supervisor again at the next logon.
