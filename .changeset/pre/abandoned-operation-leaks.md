---
"@getdomovoi/daemon": patch
---

Never abandon a resource a deadline created. A deadline rejects the moment its signal aborts,
without waiting for the operation it abandoned, so an expiry in the middle of a creation left the
only record of that resource inside the discarded operation.

Bootstrap installation now holds its staging creation and its receipt publication and settles both
in the cleanup phase. An expiry during the staging `mkdtemp` no longer skips removal and leaves a
`.runtime-` tree in the release directory, and a receipt whose hard link landed after the refusal
now keeps the runtime tree it names instead of having it deleted. Staging removal retries a
removal refused with EBUSY, EMFILE, ENFILE, ENOTEMPTY or EPERM inside the existing cleanup budget,
which is what an aborted npm child that still holds a handle produces on Windows.

Bootstrap archive publication holds its staging creation the same way. An expiry during that
creation used to report nothing about the directory it left behind; the refusal now names the
retained staging. Cleanup still shares the caller's budget, so an expired run reports the retained
path rather than removing it.

Session create and fork now remove a worktree the creation deadline abandoned. An expiry while
`git worktree add` was running left the worktree and its `domovoi/` branch with no reference, so
the existing cleanup was skipped entirely. The late result is now removed under the same agent
timeout, and a failure to remove it is reported.
