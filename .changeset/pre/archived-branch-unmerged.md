---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

A session names the branch its worktree is on (`branch`, `domovoi/<session id>`) from creation
and fork, and an archived session says how many files that branch changed that the source
checkout never received (`unmergedFiles`, read at archive before the worktree is removed: files
differing between the merge base with the source's HEAD and the branch, so a branch merged
before archive says 0). Both feed the archived notice, "Branch <b> and its final checkpoint are
kept" and "N files never merged". Sessions from an older daemon carry neither field.
