# Crash recovery

Startup reconciles interrupted turns before accepting client requests. Transfers
recover on retry. Recovery does not replay a provider turn or discard uncommitted
work.

## Interrupted turns

Startup marks pending usage records interrupted, keeps their recorded model and
usage evidence, and clears the session's active turn. Pending approvals expire,
working-plan approval blockers clear, and session history records the interruption.
The next message starts a new turn using the preserved session and worktree.

## Transfer restore claims

A bundle restore holds a per-session claim under the managed worktree root's
`.restore-claims/` directory. `.restore-leases/` contains a persistent SQLite lock
and a bounded recovery record for each session. Never unlink a lock database:
replacing its file can allow two processes to hold independent locks at one path.

The record binds the claim token to its owner PID, every running Git child PID,
and any launch whose child PID has not yet been recorded. Repository calls share
that record, including concurrent inspection commands. Aborting a command keeps
the kernel lock until its child closes and preserves the claim for inspection
afterwards: the direct child's exit does not prove its descendants stopped. A
failed concurrent query also waits for its sibling children before returning.
Claim cleanup that exceeds its deadline keeps the lock until the pending I/O
actually settles.

A successor may reclaim a matching claim only while it holds the SQLite lock and
the owner probe reports `ESRCH` (no such process), no launch is pending, and every
Git command has a recorded settlement without an abort, owned termination, or
exit signal. A live or reused PID refuses recovery. Permission errors and other
probe failures also refuse; they are not evidence that a process exited. On
retry, the successor can reclaim a claim abandoned before Git started or after
all such settlements were recorded. An absent Git PID with an unrecorded exit
never permits automatic reclamation, even after known descendants finish.
These process records apply within one OS process namespace; sharing or copying
the managed worktree root between execution environments is outside this recovery
contract.

Legacy claims without version 2 records, mismatched tokens, malformed records,
and crashes inside launch or exit recording require inspection. The refusal names
the claim and the missing evidence. Preserve the worktree and stop Domovoi, its
supervisor, and any remaining repository writers before resolving such a claim.
A claim's age alone never proves it abandoned. No recovery path resets or deletes
the worktree to make a retry succeed.

Transfer member reception has a separate SQLite lease. Retained chunks can be
retried after the receiver exits; the completed member's length and digest must
still validate before publication.

## Remaining S1.3 work

Session creation currently saves the session after creating its worktree and
starting its provider thread. A crash between those steps can leave a worktree
without a saved session. Durable creation intent and recovery of that incomplete
setup remain separate work. The restore-claim fix does not close that gap.

## Evidence and limits

`workspace-recovery.test.ts` uses separate processes: it stops the restore owner
before Git starts, while a real Git child remains alive, and before forcibly
stopping that launcher while its descendant survives. It also aborts an owned
Git command. Unrecorded or interrupted exits keep refusing recovery after the
known writers stop. Only an explicit scratch-claim removal, modelling inspection
after those writers stop, permits the latter fixtures to restore the bundle.
`workspace-restore-lease.test.ts` injects process-probe failures, incomplete
records, concurrent children, command rejection before child close, and an early
`Promise.all` rejection while a sibling child remains active.
`workspace.test.ts` retains the ownership-token and delayed-cleanup tests.

Windows CI run [34713763719](https://github.com/getdomovoi/domovoi/actions/runs/34713763719)
measured the restore owner and recorded Git launcher absent while the holding
descendant and its parent remained alive. The old guard incorrectly restored.
Node 22.23.2's [Windows process implementation](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/win/process.c#L65-L91)
places direct spawned children in an owner job with kill-on-close, while allowing
their subprocesses to escape that job. This is why direct PID absence cannot
stand in for recorded settlement. The local forced-launcher-death probe reproduces
the same overlap without relying on Windows job behaviour.

These prove process-crash recovery and refusal boundaries. They do not prove
recovery from filesystem corruption, background helpers outliving a normally
settled Git command, or arbitrary external repository writers. PID reuse remains
a conservative refusal pending a separate process-identity decision.
