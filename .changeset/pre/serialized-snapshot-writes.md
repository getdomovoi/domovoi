---
"@getdomovoi/daemon": patch
---

Whole-snapshot writes no longer discard concurrent changes. An arriving `transfer.commit` imports only its session into the live workspace at the save point, so two overlapping commits keep both sessions. `session.fork` merges only the new session into the live workspace, so text another session streams during the save is kept. The transfer commit, the provider thread restart and the ownership-conflict write now join the persistence serializer, so a worker write posted earlier can no longer land after them and put an older snapshot back on disk.
