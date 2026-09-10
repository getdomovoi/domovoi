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
