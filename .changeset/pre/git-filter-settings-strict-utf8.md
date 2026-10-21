---
"@getdomovoi/daemon": patch
---

The daemon reads a repository's Git filter settings as strict UTF-8, as the isolated checkout already does. A scope, file name, key or value that is not valid UTF-8 makes the Git config unreadable (`git-failed`), so `tool.inventory` never lists a filter with replacement characters that a review could approve, and the gate refuses as it does for any config it cannot read.
