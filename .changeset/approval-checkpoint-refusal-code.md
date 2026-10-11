---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
"@getdomovoi/mobile": minor
---

When an allow cannot take its checkpoint, `approval.resolve` now says why as data. The daemon
answers with the new error code `approvalCheckpointErrorCode` (-32023) and an
`approvalCheckpointRefusalSchema` as the error's data: `lock-held` with the lock path Git reported,
`submodule-changes`, `repository-config`, `git-unavailable`, `timed-out`, `git-failed` or
`unknown`. A lock path is accepted only when Git printed its English lock message and the path is
absolute, ends in `.lock` and holds no control characters; anything else is a plain Git failure.
The error message keeps the daemon's sentence for older clients; it was `internalError` or
`invalidParams` before. The desktop and web approval card and the phone's decision line draw
"Could not take a checkpoint: <cause>. Nothing ran." from the data, with the lock path in the
machine font on the card, and fall back to the daemon's words for data they cannot read. For a
repository config or a missing Git the daemon's sentence follows the line, because it names the
setting or what to install.
