---
"@getdomovoi/daemon": minor
---

A repository trusted on this machine now runs its own git filters. When the repository's
configuration digest read at the call equals this machine's grant, the grant was made by a client
that showed the filters (`repository.trust` `gitFilters.reviewed`, recorded only when the read
listed every filter; a `reviewDigest` other than the one the daemon's own read gives grants
nothing) and nothing in it refuses trust, the filter definitions the grant reviewed
run at session create and fork, a transfer arriving,
checkpoint, snapshot, restore, file revert, a transfer leaving and evidence. They run as the values
the digest covers, passed as command-line config, so a change to the repository's config after
that read changes nothing that runs. A session worktree that reads other filters than the project
root (an `includeIf "onbranch:"` include, an edited `config.worktree`), a configuration that
changed since trust, or trust taken back while the operation runs refuses with
`repositoryGitFilterErrorCode` and nothing runs. Every existing grant, and any grant from a client
that does not acknowledge the filters, keeps them held back with a refusal that says to review and
trust the repository again from an updated client; grants for repositories without filters behave
as before. The grant keeps the review digest of the git filter block it acknowledged, and the
filters run only while the block read at the operation lists every filter and has that digest:
the configuration digest does not cover the file that sets a filter, so settings moved to another
file keep the configuration digest but hold the filters back until the repository is trusted
again. The trust store gains columns for the acknowledgement and that digest, 0 and NULL for the
grants already in it, and refuses a table with a foreign key or a trigger that names it.
A driver's `filter.<driver>.required` is reviewed with its commands and pinned to the reviewed
value; `tool.inventory` shows its effective state with each driver command. A `required` value Git
would not read as a boolean, or a filter command written with no value, in any scope, is a config
Git stops on: Domovoi reads it as unreadable and refuses, naming the key. A trusted filter runs as you, including a command that runs a file in the repository,
which an agent's edit also changes.

Checkpoint, snapshot, restore, file revert, transfer and evidence now run every Git command that
reads or writes the worktree's files or index in the same temporary Git directory as a new
session's checkout, so no repository config key (core.sshCommand, core.askPass, a credential
helper, core.fsmonitor, a Git LFS program setting, an included file) starts a program there,
trusted or not. A filter command the repository's own config sets to empty, over one your global
or system config sets, stays empty there too, so the inherited command runs no more than it does
in ordinary Git. Commits are written with Git's plumbing, since `git commit` and every index write
can run a clean filter. A checkpoint stages and commits in an index of its own, seeded from the
worktree's, so a failed checkpoint leaves the worktree's index as it was and undoes nothing another
Git wrote meanwhile; on success the worktree's index becomes the checkpoint's, written under
`index.lock` as Git writes one, only if it still holds the entries it had at the start. Those operations read the exact `git lfs install` lines as exempt and the
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
with the filtered transports, fetches one. Git before 2.45 cannot be kept from lazy fetching, so
on it, or when the version cannot be read, a repository or worktree that is a partial clone by
its own config is refused with a message naming the Git version needed; other repositories work
as before.

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
