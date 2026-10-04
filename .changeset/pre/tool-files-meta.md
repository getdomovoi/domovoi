---
"@getdomovoi/protocol": patch
"@getdomovoi/ui": patch
---

Report the files a turn touched on the activity row

A tool thread item can now carry the paths that call touched. The activity row
reads those paths to show how many tools ran, how many distinct files they
touched, and which tool is still running. Counts come from reported paths only;
nothing is inferred from a command title. Older snapshots without the field
still load.
