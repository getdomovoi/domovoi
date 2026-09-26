---
"@getdomovoi/daemon": patch
---

A checkpoint now includes a file whose name is only whitespace. The daemon read the staged file list
through a helper that trims git's output, which stripped such a name from the NUL-delimited list, so
a checkpoint whose only change was that file found nothing to commit and saved nothing.
