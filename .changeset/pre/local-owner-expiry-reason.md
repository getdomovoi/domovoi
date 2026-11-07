---
"@getdomovoi/daemon": patch
---

Report a machine that ran out of time as an unreachable owner rather than an invalid profile.
Acquiring the local daemon recognised an expired budget only when the deadline error was the one
thrown. A startup step that bounds itself reports its own expiry and carries the deadline as a
cause, so credential initialization timing out was classified as `profile-invalid`, and the
refusal told the person to inspect their owner record, private key and credential file. Nothing
was wrong with any of them; the machine was slow.

The classification now looks through the wrapper, including the aggregate a step raises when its
cleanup also failed, and answers `owner-unreachable`, which says to wait for the daemon or start
it explicitly. A genuinely damaged profile still reports `profile-invalid`.
