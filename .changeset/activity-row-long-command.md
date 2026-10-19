---
"@getdomovoi/ui": patch
---

The activity row stays one line while a long command runs. It names the running command by its
first line, cut to 72 characters with an ellipsis, instead of drawing a multi-line script inside the
row. A step whose command was cut opens to the whole command above its log.
