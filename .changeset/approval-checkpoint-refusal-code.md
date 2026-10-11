---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
"@getdomovoi/mobile": minor
---

When an allow cannot take its checkpoint, `approval.resolve` now says why as data. The daemon
answers with the new error code `approvalCheckpointErrorCode` (-32023) and an
`approvalCheckpointRefusalSchema` as the error's data: `lock-held` with the lock path Git reported,
`submodule-changes`, `repository-config`, `repository-config-unreadable`, `git-unavailable`,
`timed-out`, `git-failed` or `unknown`. A lock path is sent only when Git printed its English lock
message, the lock file is there when the daemon looks (read with a 2 second bound), it lies in the
worktree's own Git directory or common directory, the redactor leaves it unchanged, and it is
absolute, ends in `.lock` and holds no control characters; anything else is a plain Git failure. A
filter can print the same sentence, so the sentence alone names nothing. A Git that cannot start
(the spawn's ENOENT on macOS and Linux, a `GitNotFoundError` on Windows) is `git-unavailable`.
The error message keeps the daemon's sentence for older clients; it was `internalError` or
`invalidParams` before. The desktop and web approval card and the phone's decision line draw
"Could not take a checkpoint: <cause>. Nothing ran." from the data, with the lock path in the
machine font on the card, and fall back to the daemon's words for data they cannot read. For a
repository config, an unreadable config or a missing Git the daemon's sentence follows the line,
because it names the setting, what Git stopped on, or what to install. The lock line says the lock
is held by another git process or was left by one that stopped, since Git cannot tell which.
