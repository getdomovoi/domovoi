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

- commits only in the session's own worktree under the worktree root, only on its
  branch `domovoi/<session>`, and refuses when HEAD names any other branch or none,
  or when that branch moved since the person read the changes (`expectedHead`);
- refuses in Ask and Plan, which run read-only, and while a turn runs. Build allows
  it with or without Auto, since the commit is always the person's own action;
- stages and commits through the isolated Git directory checkpoints use, so no
  repository hook runs and no repository config can start a program, and signs
  nothing;
- refuses the whole commit when a path it would add or change names a credential,
  a private key or an environment file, counting them without naming them, and
  refuses a message the durable-text redactor would change. Deleting a tracked
  secret file is allowed;
- moves `refs/heads/domovoi/<session>` from `expectedHead` and nothing else, keeps
  the commit under `refs/domovoi/checkpoints` like every checkpoint, and pushes
  nothing;
- authors the commit as the person when Git has both `user.name` and `user.email`
  for the worktree, as Domovoi otherwise, with Domovoi as the committer.

The thread item and its history entry carry a `committed` record: the message, the
branch, the first 50 paths and the count of all of them, and the kind of client that
asked. Only a `commit` checkpoint carries that record, and it always does. A commit
is restored and forked like any other checkpoint.
