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
fail. When a checkpoint fails after staging, for any reason, the index is put back byte for byte
as it was, so the worktree is not left staged and anything the person had staged stays staged.

Git filter drivers set in the repository's own config (local or worktree scope) now refuse
checkpoint, restore, file revert, archive and transfer with an error that names the filter and the
config that sets it. Git runs a filter's command on every add, checkout and reset, and a
repository-set command such as `./scripts/clean.sh` runs a file the agent can edit. Turning the
filter off instead would change what a checkpoint stores, for example git-crypt plaintext. Filters
from your global or system Git config, such as Git LFS, still run.

The file-change view reads its evidence with those repository-set filters treated as absent, so
their commands never run there. A filtered file can show as changed in that view; nothing is
stored.

Daemon Git commands no longer inherit Git settings from the daemon's own environment
(`GIT_CONFIG`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_COUNT`
and its keys and values, `GIT_CONFIG_PARAMETERS`, `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_EXEC_PATH`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_EXTERNAL_DIFF`,
`GIT_PAGER`, `GIT_EDITOR`). Session push and fetch replace an ssh command, askpass, credential
helper, upload-pack or receive-pack that the repository's own config sets with your global or
system value, or Git's default, turn the `ext` transport off and skip push signing. A URL rewrite
or proxy command the repository's own config sets refuses the push or fetch with an error that
names it. A restore into a session worktree this machine already holds checks that worktree's own
config for filters too.
