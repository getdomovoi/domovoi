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
repository's filters treated as absent; a diff driver's `diff.<driver>.binary` setting is carried,
so a file the repository marks binary stays out of the evidence diff, and external diffs and text
conversion stay off. A session bundle is written in that directory too, from object ids and with
lazy fetching off, so a partial clone's missing blob fails the transfer instead of being fetched
with the repository's own transport settings. Restore clears the merge, cherry-pick, revert and
finished sequencer state `git reset --hard` clears, and refuses while a submodule has local
changes, as a snapshot does. Push and fetch for a transfer allow only https, http, ssh and git
remotes, and refuse a remote whose address is anything else, a local path or a file:// URL
included, or that names a remote helper; a received bundle is still read from its own file, with
lazy fetching off, so a prerequisite the target lacks fails the transfer instead of being fetched
from a promisor remote the target's config names. Neither fetch recurses into submodules.
Submodules are checked for local work each through an isolated Git directory of its own, the
superproject's status and diff keep out of submodule worktrees, and checkpoint, snapshot, restore,
revert and transfer refuse while a checked-out submodule's own Git config sets a filter or makes it
a partial clone, which no trust covers. Every other daemon Git command runs with lazy fetching off
(Git 2.45 and later), so a partial clone's missing object fails the command instead of being
fetched through the repository's own promisor and transport config; only the isolated directory,
with the filtered transports, fetches one.

Under trust, a filter runs in a process group of its own on macOS and Linux, and a timeout or an
emergency stop ends the whole group. A process a filter started can leave that group, so after a
kill the operation's descendants count as unknown: a session create stopped part way keeps its
worktree and branch for recovery rather than deleting them under a writer that may still run.
Taking trust back restarts no thread for a filter. Files already checked out under trust stay as
they are, and archiving a session no longer refuses, since removing its worktree runs no filter.

Checkpoint, restore, revert and `session.transfer` refused over a repository filter now answer
with `repositoryGitFilterErrorCode` and its data, as `session.create` and `session.fork` do, and
so does `transfer.commit` on the target. `tool.inventory` reports a repository's git filters as
running, not held back, under a grant for the digest read now.
