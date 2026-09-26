---
"@getdomovoi/protocol": patch
"@getdomovoi/ui": patch
---

Carry how far a tool call moved each file, so the thread can name a touched
file and its added and removed line counts. A count derived from the worktree
would describe the tree now rather than that turn, and would drift once a
later turn lands. An entry stays a bare path when the provider reported no
diff, and an older snapshot that lists paths only still loads.
