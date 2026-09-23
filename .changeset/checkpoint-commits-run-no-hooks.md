---
"@getdomovoi/daemon": patch
---

Daemon Git commands never run repository hooks. A relative `core.hooksPath` resolves inside the
session worktree, where the agent can write, so a checkpoint on archive, provider switch,
transfer, restore or file revert used to run a hook file the session had edited, with the
daemon's full user rights and outside any gate or sandbox. Every Git command the workspace
service runs now points `core.hooksPath` at a path that cannot be a directory and turns
`core.fsmonitor` off.

Checkpoint commits also skip commit signing. A signing setup with no key for the Domovoi
committer, or a failing `pre-commit` hook, no longer makes every checkpoint in that repository
fail. When the checkpoint commit fails for any other reason, the index is reset so the worktree
is not left staged.
