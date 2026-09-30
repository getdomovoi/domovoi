---
"@getdomovoi/daemon": patch
---

Taking repository trust back now stops the agent threads that loaded the repository's trusted
configuration. An adapter reports that through the optional `repositoryTrustApplied`, which the
daemon asks after each call that carried a grant; a grant that was passed and not applied leaves
the thread alone. The Claude adapter reports it.

`repository.revokeTrust` deletes the grant first, then, for every such thread of the project,
interrupts its active turn and stops the thread, each within the agent timeout, and lists the
session in `threads`. It is `restarted` when the stop resolved and `unconfirmed` when the stop timed
out or failed. A Codex thread is `unconfirmed` either way, since Codex runs every thread in one
app-server and cannot confirm that the tool servers a thread started have exited. An unconfirmed
session is marked failed and fenced as an emergency stop fences a thread it could not stop. The number
of threads never refuses a revoke: every thread stops, the result lists the first 1,024, and
`omittedThreads` counts the rest.

A thread is tracked from the moment the provider call returns, before anything is saved, and
stays tracked until its exit is confirmed. An unconfirmed thread stays tracked and fenced, and
every later revoke tries to stop it again. So is a thread that a failed session start, fork,
restart or handoff could not stop, and one that quarantine, a transfer or an ownership conflict
dropped without confirming its exit. A revoke attempts every stop even when holding a queued send
or clearing approvals fails, and reports those failures afterwards. Cleanup of a failed handoff
thread is now bounded by the agent timeout. A start that lands after its call timed out is
tracked before its late cleanup stops it. A resume or turn start that carried a grant and then
timed out or failed is tracked as if it applied the grant before its thread is quarantined, and
one that lands after its timeout is stopped as a late start is. Until such a call settles, its
thread stays tracked whatever stops it meanwhile, and a revoke stops it; when it settles, resolved
or rejected, a thread whose adapter reports the grant applied is stopped again. A thread leaves
tracking only when no grant-carrying call and no late or abandoned stop on it is in flight, and a
stop that began after the last point a grant may have been applied has resolved. A revoke that stops a session
waiting on an approval leaves it idle, as it does a session with an active turn.

A stopped Codex thread that loaded trusted configuration is never counted as exited, since
archiving it cannot confirm that the tool servers it started exited. While the grant holds, those
run under consent: a Codex thread stopped on any other path (archive, project switch, emergency
stop, quarantine, a provider switch, a failed start) is remembered and fences nothing. A revoke of
the project reports each remembered thread `unconfirmed` and fences its session until the daemon
restarts; a new grant does not lift that.

While a session has a thread that loaded trusted configuration and that it no longer names, or one
that is fenced, a message, a restart, a provider switch or a fork of that session is refused with
"Provider thread requires recovery after emergency stop". Each attempt first tries to stop the
thread again, and a confirmed stop lifts the fence. A thread a revoke is stopping fences its
session from the moment it is claimed, and a stop on another path that finishes meanwhile does not
release it. When a revoke or such a retry confirms a stop that an earlier revoke or emergency stop
could not, that thread's fence is lifted, and a failed session that names a thread is usable again
once no other thread holds it. A Codex stop never lifts a fence this way, and a Codex thread whose
earlier stop failed stays fenced after a later stop resolves. A fork of a session whose own thread
an emergency stop could not stop is refused until the session is recovered, as a message is.
Recovering such a session by switching its provider is refused when that thread is a Codex thread
that loaded trusted configuration, since no stop can confirm its tool servers exited; it stays
fenced until the daemon restarts. Recovery of any other thread is unchanged.

Nothing resumes a stopped thread: the next message resumes it, and that resume carries no grant. A
queued send is held with "Repository trust was taken back before the queued send could release."
Each stopped session gets a notice: "Repository trust was taken back, so the agent was stopped."
with "The next message resumes it without this repository's configuration.", or, when unconfirmed,
"Repository trust was taken back, and Domovoi could not confirm that the agent stopped." with "It
may still be running with this repository's configuration, so Domovoi will not start another agent
here. Restart Domovoi to clear it, or archive the session."

A revoke that arrives during an emergency stop takes the grant back at once and stops what the
emergency stop left once it finishes. An emergency stop that begins during a revoke does not
interrupt the turns the revoke is stopping, and the revoke still answers with its result. Threads
that loaded nothing under a grant, and other projects' grants, are not touched.
