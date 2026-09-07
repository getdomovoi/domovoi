# Bundle restore claim lifecycle

Bundle restore reserves a session synchronously in the process and then creates
`.restore-claims/<session-id>` exclusively under the worktree root. The file contains a
random ownership token. A competing restore refuses before repository work. Claims are
never stolen on age, timeout, or cancellation.

After repository work settles, release gets one fresh ten-second deadline shared by
descriptor close, pathname ownership read, and unlink. An immediate close failure still
permits ownership-checked unlink within the remaining budget. The release error preserves
the original failure as its cause, including a non-Error failure. A completed restore is
reported as completed and must not be repeated just because claim release failed.

| State | Admission and transition |
| --- | --- |
| Restoring | Exclude competing restores until repository work settles. |
| Releasing | Keep exclusion while close, ownership read, and unlink use the release budget. |
| Quarantined | Return the release deadline error to the caller. Refuse the same session with the claim path while the outstanding I/O is still pending. Other sessions remain available. |
| Released | Drop the process reservation only after outstanding I/O actually settles. Any remaining claim file still excludes every process. |

Close and unlink cannot be cancelled by an AbortSignal. Expiry therefore ends the wait,
not the filesystem operation. No ownership read or unlink starts after an earlier step
exceeds the deadline. Late rejections are observed. An unlink already issued at expiry
may still remove the claim, so the reservation stays quarantined until that call settles,
even if the pathname is already absent. There is no timer that admits a successor while
an old unlink is pending.

If close or ownership read settles after expiry, the claim stays on disk for inspection.
If an already-issued unlink succeeds late, subsequent admission is available once it
settles. A process exit drops its process reservation, but does not prove an on-disk claim
is stale while another daemon may still own it.

For a stuck or stale claim, stop every Domovoi process using that worktree root and their
supervisors. Confirm that the named claim has no live owner, inspect the reported restore
outcome and resulting worktree, and only then remove that claim. Token verification and
pathname unlink are separate filesystem operations; deleting or replacing claims while
daemons are running is unsupported. No protocol schema changes are involved.
