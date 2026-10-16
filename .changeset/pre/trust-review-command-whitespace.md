---
"@getdomovoi/ui": patch
---

The trust sheet and the Tools tab keep a command's whitespace when they show it for review. A browser collapses runs of spaces in ordinary text, and two spaces inside quotes are another shell argument than one, so each filter command is drawn as its own text, apart from its operation, with its whitespace kept, and hook and tool server commands keep theirs too.
