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
that record, including concurrent inspection commands. Aborting a command does
not release exclusion until its child closes. Claim cleanup that exceeds its
deadline also keeps the lock until the pending I/O actually settles.

A successor may reclaim a matching claim only while it holds the SQLite lock and
every recorded process probe reports `ESRCH` (no such process). A live or reused
PID refuses recovery. Permission errors and other probe failures also refuse;
they are not evidence that a process exited. On retry, the successor can reclaim
a claim abandoned before Git started, or after surviving Git children finish.
These process records apply within one OS process namespace; sharing or copying
the managed worktree root between execution environments is outside this recovery
contract.

Legacy claims without records, mismatched tokens, malformed records, and crashes
inside the launch-recording window require inspection. The refusal names the
claim and the missing evidence. Preserve the worktree and stop Domovoi, its
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
before Git starts and while a real Git child remains alive. The latter case
refuses a successor until the child exits, then restores the same bundle.
`workspace-restore-lease.test.ts` injects process-probe failures, incomplete
records, concurrent children, and command rejection before child close.
`workspace.test.ts` retains the ownership-token and delayed-cleanup tests.

These prove process-crash recovery and refusal boundaries. They do not prove
recovery from filesystem corruption or arbitrary external repository writers.
