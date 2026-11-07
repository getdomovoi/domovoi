---
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
"@getdomovoi/mobile": patch
"@getdomovoi/cli": patch
---

Every instruction to remove a paired client now says Unpair, the word its row on Machines shows,
and says where that control is: in the desktop app on that machine, under Machines. This covers
`domovoid pair` output, the Authorize this client dialog, the alert after removing local access,
the browser pairing cards, the phone's pairing refusals, and `domovoi pair` refusals. Machine
bindings keep Revoke.
