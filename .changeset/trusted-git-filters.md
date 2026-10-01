---
"@getdomovoi/daemon": minor
---

A repository trusted on this machine now runs its own git filters. When the repository's
configuration digest read at the call equals this machine's grant and nothing in it refuses trust,
the filter definitions the grant reviewed run at session create and fork, a transfer arriving,
checkpoint, snapshot, restore, file revert, a transfer leaving and evidence. They run as the values
the digest covers, passed as command-line config, so a change to the repository's config after
that read changes nothing that runs. A session worktree that reads other filters than the project
root (an `includeIf "onbranch:"` include, an edited `config.worktree`), a configuration that
changed since trust, or trust taken back while the operation runs refuses with
`repositoryGitFilterErrorCode` and nothing runs. A trusted filter runs as you, including a command
that runs a file in the repository, which an agent's edit also changes.

Checkpoint, snapshot, restore, file revert, transfer and evidence now run every Git command that
reads or writes the worktree's files or index in the same temporary Git directory as a new
session's checkout, so no repository config key (core.sshCommand, core.askPass, a credential
helper, core.fsmonitor, a Git LFS program setting, an included file) starts a program there,
trusted or not. Commits are written with Git's plumbing, since `git commit` and every index write
can run a clean filter. Those operations read the exact `git lfs install` lines as exempt and the
Git LFS program settings as repository filters, as a new session's checkout does, and refuse
while the repository's Git config cannot be read. Without trust, evidence still reads with the
repository's filters treated as absent.

Under trust, a filter runs in a process group of its own on macOS and Linux, and a timeout or an
emergency stop ends the whole group, so nothing a filter started outlives its operation; a stopped
session create leaves no worktree or branch behind. Taking trust back restarts no thread for a
filter. Files already checked out under trust stay as they are, and archiving a session no longer
refuses, since removing its worktree runs no filter.

Checkpoint, restore, revert and `session.transfer` refused over a repository filter now answer
with `repositoryGitFilterErrorCode` and its data, as `session.create` and `session.fork` do, and
so does `transfer.commit` on the target. `tool.inventory` reports a repository's git filters as
running, not held back, under a grant for the digest read now.
