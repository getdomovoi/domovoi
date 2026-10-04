---
"@getdomovoi/ui": patch
---

The Tools tab's read line counts the Git config files the repository's filters come from, each path once, and counts a Git config Domovoi could not read as unreadable, so a repository whose only config is a Git filter no longer reads "0 files" beside its `.git/config`.
