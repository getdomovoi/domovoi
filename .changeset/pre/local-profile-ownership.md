---
"@getdomovoi/daemon": minor
---

Prevent CLI, service and Desktop daemons from writing the same profile concurrently. A separate
profile lease precedes store construction. Local clients can acquire an owned handle or attach
only after a same-socket instance proof and ordinary authenticated hello. Attachments cannot stop
the owner, and restarting or unconfirmed owners never trigger a Desktop fallback.
An attached handle notifies the client when its verification socket closes, without polling or
automatic reacquisition.

Service installation refuses while the profile is owned. Close Desktop, install or start the
service, then reopen Desktop to attach. Port zero requests a kernel-assigned port and discovery
reads the current bound endpoint from the owner record. Stop older processes before upgrading;
they do not participate in the new lease protocol. Windows retains the existing user-profile ACL
policy. The daemon's declared Node requirement now matches the repository's Node 22.13.0 minimum.
