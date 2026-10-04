---
"@getdomovoi/daemon": patch
---

A Git read from Claude Code no longer asks just because Git LFS is set up: the four filter lines
`git lfs install` writes are allowed when they are exactly `git-lfs clean -- %f`,
`git-lfs smudge -- %f`, `git-lfs filter-process` and `true`. Any other filter or value still asks.
In a repository with a submodule every such Git read now asks, because git status runs each
submodule under its own configuration.
