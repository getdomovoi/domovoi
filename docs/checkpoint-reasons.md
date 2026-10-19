# Checkpoint reasons

CX5 adds an optional `reason` to checkpoint thread items and checkpoint history
entries. New daemon-created checkpoints name their reason independently of their
label and commit:

| Reason | Boundary |
| --- | --- |
| `session-start` | The base commit of a newly created session worktree |
| `fork` | The checkpoint used to create a forked session |
| `manual` | A user requested checkpoint, regardless of the chosen label |
| `before-restore` | Recovery state saved before restoring a checkpoint |
| `before-revert` | Recovery state saved before reverting a file |
| `before-provider-handoff` | Recovery state saved before switching provider |
| `before-provider-recovery` | Recovery state saved before replacing a failed provider thread |
| `before-archive` | Recovery state saved before archiving the session |

The new session-start row carries `createSessionWorkspace`'s base commit, retained
under the same durable Git checkpoint refs used by restore and transfer. Clients
can suppress its fork action with `entry.reason === "session-start"`, including
when history is paged. A later checkpoint can share its commit without becoming a
session-start checkpoint. The session's mutable `baseCommit` cannot identify this
boundary either.

Legacy rows keep `reason` absent. The daemon does not derive it from labels, commit
equality or position. Reasons survive snapshot persistence and session transfer.
They describe why a checkpoint exists; they do not create per-turn fork points.

## Commit checkpoints

`commit` marks a commit a person asked for with their own message, through
`session.commit`. An agent's sandbox cannot write a linked worktree's Git metadata,
and Domovoi keeps it that way (walk finding F10), so the person commits the
session's work from the Changes tab instead. The daemon:

- commits only in the session's own worktree under the worktree root, a linked
  worktree registered in the session's project repository, only on its branch
  `domovoi/<session>`, and refuses when HEAD names any other branch or none, when
  that branch is a symbolic ref, or when it moved since the person read the changes
  (`expectedHead`);
- requires `expectedChangesDigest`, the revision supplied by `session.evidence`.
  Evidence hashes every changed path, including paths beyond the 200-row display
  limit, from private staging passes around the same stable read as the file list.
  Raw path bytes, status, old and new modes, and full blob or gitlink IDs determine
  the digest. Renames count as deletion plus addition. Symlink targets are blobs.
  Evidence discards its staged objects. After staging the commit's private index,
  the daemon compares its digest before creating a commit. A mismatch leaves the
  shared index, worktree and refs untouched and asks the person to refresh and
  review the changes again. Missing request digests are invalid; older evidence
  without a digest remains readable but cannot authorize a commit;
- refuses in Ask and Plan, which run read-only, and while a turn runs. Build allows
  it with or without Auto, since the commit is always the person's own action;
- stages and commits through the isolated Git directory checkpoints use, so no
  repository hook runs and no repository config can start a program, and signs
  nothing. Unlike a checkpoint, it refuses while the repository's own config sets a
  filter, a reviewed and trusted one included: it would have to run it, and
  committing without it would commit what the filter exists to change. Filters in
  the person's global or system config, and the exact `git lfs install` lines in
  the repository's own config (ruling Q207 A, kept for commits by Q139), run as
  they do for every Git command;
- refuses whenever the isolated directory holds back anything from the
  repository's own config (local and worktree scope, included files among them):
  a filter driver it blanks, a Git LFS extension or transfer it leaves out, or any
  key it does not carry (ruling Q140). This is derived, not listed: for every key
  the repository sets, the directory must read the worktree's effective value and
  every value the repository gives it, compared between the worktree's whole
  config and the directory's whole config. It is decided from the one config read
  the directory is built from, and again once staging is done, so a setting that
  appears after the gate read (an include edited, a config change in between)
  refuses too. The second read also refuses any key whose values changed since the
  first, in any scope, such as a repository override removed so a global value
  shows through. The worktree's sparse-checkout patterns are always carried, so
  Git applies them whenever its own reading of `core.sparseCheckout` turns sparse
  checkout on (`1` and `yes` included). The only list is of keys known to change nothing a commit stores or
  runs (`commitInertKeys` in `workspace.ts`: repository layout, hooks and
  fsmonitor, index and storage formats, other commands' programs, branches and
  remotes, the identity), so a key nothing names, a later Git's included, refuses.
  The refusal names the keys, redacted, never their values;
- refuses the whole commit when a path it would add or change names a credential,
  a private key or an environment file, submodule entries the repository asks Git
  to ignore included, counting them without naming them, and refuses a message the
  durable-text redactor would change. Deleting a tracked secret file is allowed;
- moves `refs/heads/domovoi/<session>` itself (`update-ref --no-deref`) from
  `expectedHead` and nothing else, keeps the commit under `refs/domovoi/checkpoints`
  like every checkpoint, and pushes nothing. Once the branch has moved, a later
  failure (the checkpoint ref, the worktree's index, a deadline) is recorded beside
  the commit, never reported as a commit that did not happen;
- authors the commit as the person when Git has both `user.name` and `user.email`
  for the worktree, as Domovoi otherwise, with Domovoi as the committer.

The thread item and its history entry carry a `committed` record: the message, the
branch, the first 50 paths and the count of all of them, and the kind of client that
asked. Only a `commit` checkpoint carries that record, and it always does. A commit
is restored and forked like any other checkpoint.
