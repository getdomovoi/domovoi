# Crash recovery

Startup reconciles interrupted turns and session creation for the loaded project
before accepting client requests. Opening another project reconciles its pending
creation intents. Transfers recover on retry. Recovery does not replay a provider
turn or discard uncommitted work.

## Interrupted turns

Startup marks pending usage records interrupted, keeps their recorded model and
usage evidence, and clears the session's active turn. Pending approvals expire,
working-plan approval blockers clear, and session history records the interruption.
The next message starts a new turn using the preserved session and worktree.

## Managed worktree claims

Bundle restore, session creation, checkpoint forks, and creation-receipt validation
hold a per-session claim under the managed worktree root's `.restore-claims/`
directory. `.restore-leases/` contains a persistent SQLite lock and a bounded
recovery record for each session. Never unlink a lock database: replacing its file
can allow two processes to hold independent locks at one path.

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

## Interrupted session creation

Create and fork record a SQLite intent before starting Git. It contains the
creator PID, a failed-session draft, repository path, and expected managed worktree
location. A separate completion receipt records the worktree path, branch, and
base commit only after the guarded Git operation and claim cleanup settle. That
receipt precedes provider setup; it does not claim a provider thread was created.
The journal admits at most 1,024 pending intents across projects and 64 KiB of
UTF-8 JSON per intent. Exhaustion refuses new setup without replacing old evidence.

Recovery requires the creator probe to return `ESRCH`. A live or reused PID,
permission error, or other probe failure defers recovery and preserves the intent.
Only the loaded project's intents are recovered; other projects wait until opened.

An abandoned intent becomes a failed session. Recovery starts no provider thread.
If a completion receipt exists, Git must still verify the canonical worktree
location, repository, managed branch, and HEAD under the worktree claim. A verified
receipt exposes the preserved worktree and a recovered checkpoint. The existing
explicit provider-restart action can then continue the session.

Readable Git metadata alone is not a completion receipt. A missing or invalid
receipt leaves the session without a usable worktree path. Its system history
records the preserved setup location for inspection; provider restart refuses it.
Recovery neither reconstructs an unproven checkout nor deletes its files.

The recovered snapshot commits before journal cleanup. A leftover intent for an
already-saved session is deduplicated by session ID. Failed journal deletion is
reported without turning a durable session commit into an RPC refusal. Normal
failed-setup cleanup removes an intent only after worktree removal settles,
including when setup or cleanup finishes after the request's deadline. Failed or
pending removal retains the intent and refuses a repeated fork request.

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

`session-creation-recovery.test.ts` terminates a separate creator after Git
completes, on either side of receipt publication, for both create and fork. It
checks preserved uncommitted content, one recovered failed session, and no provider
replay. Additional probes cover explicit restart, wrong HEAD, symlink replacement,
owner-probe failures, dormant projects, failed snapshot and receipt publication,
stale-intent deletion failure, and late removal held behind a fixture gate.
`session-creation-intents.test.ts` exercises journal ownership, record and count
bounds, duplicate refusal, and failed SQLite writes. Mutations that discard before
removal or snapshot persistence, treat `EPERM` as absence, or trust an unverified
receipt each fail their corresponding regression.

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

External termination of a Git child on Windows is not covered. An exit reported
only as an ordinary nonzero code, without a signal or an owned-kill flag, cannot
be distinguished from a normal Git failure by this record. That native path has
not been probed.
