---
"@getdomovoi/ui": patch
---

The trust sheet lists a filter driver's commands as a definition list: each operation and its command is a row of its own, the operation in a label column and the command in a bounded block that keeps its whitespace, with no delimiter text between rows. A command whose text holds an operation's name, such as `review-label · clean review-clean`, no longer reads like a second operation. The Tools tab's list of running filters draws each command in the same bounded block.
