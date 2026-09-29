---
"@getdomovoi/daemon": patch
---

Taking repository trust back now stops the agent threads that opened under it. The daemon records
each provider thread a trust grant was passed to. `repository.revokeTrust` deletes the grant first,
then, for every such thread of the project, interrupts its active turn and stops the thread, each
within the agent timeout, and lists the session in `threads`. It is `restarted` when the stop
resolved and `unconfirmed` when the stop timed out or failed. A Codex thread is always
`unconfirmed`, since Codex runs every thread in one app-server and cannot confirm that the tool
servers a thread started have exited. An unconfirmed session is marked failed and fenced as an
emergency stop fences a thread it could not stop.

Nothing resumes a stopped thread: the next message resumes it, and that resume carries no grant. A
queued send is held with "Repository trust was taken back before the queued send could release."
Each stopped session gets a notice: "Repository trust was taken back, so the agent was stopped."
with "The next message resumes it without this repository's configuration.", or, when unconfirmed,
"Repository trust was taken back, and Domovoi could not confirm that the agent stopped." with "It
may still be running with this repository's configuration, so Domovoi will not start another agent
here. Restart Domovoi to clear it, or archive the session."

A revoke that arrives during an emergency stop takes the grant back at once and stops what the
emergency stop left once it finishes. An emergency stop that begins during a revoke does not
interrupt the turns the revoke is stopping, and the revoke still answers with its result. Threads that opened without a grant, and other projects' grants, are not
touched. The adapters still ignore the grant, so in this release no thread loads repository
configuration under it; the stop applies to every thread a grant was passed to.
