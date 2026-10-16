---
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

Stop an OpenCode or Kilo session when its server reports an approval reply the daemon did
not send. Both servers read their password only from their startup environment, which every
program they start can read as the same user. A reply counts as the daemon's only once the
server has accepted the daemon's answer. Any other reply refuses every request still waiting,
aborts the session's runs and waits for the server to confirm, fails the session with
`approval-answered-elsewhere`, holds a queued send, and records
`provider.approval-answered-elsewhere` in the audit log. The audit entry and the session's
notice name the answered card and its facts as the card showed them (operation, command,
directory, affected files, tool server, hard gate), read when the report arrives, or say the
answer matched no card. The audit entry says the match was made against the cards shown then
(`match=currently-shown`); when none matched, the notice adds that a Domovoi decision may
already have been saved or sent and that its acceptance was not confirmed. They are recorded even when an archive, a transfer or an emergency
stop took the session before the report was handled; only a session still running is
stopped. Until then the answered card gets no deny from an archive or an emergency stop, which
note instead that it was answered outside Domovoi, and a person's answer to it is refused,
including one already being saved, so neither its receipt nor a standing rule is kept. A
standing rule is now saved only after the decision that makes it is committed, and first as a
rule pending delivery, which never answers a request. It is made active only after delivery:
the adapter's `resolveApproval` returned for a request it was tracking as waiting, which is
not an acknowledgement from the provider. Every provider adapter now throws
`ApprovalRequestNotPendingError` for an answer to a request it is not waiting on, instead of
dropping it silently. An emergency stop that begins while the pending rule is saved cancels the
decision: it is never sent, its receipt and rule are taken back, and what the stop removed
stays removed. A daemon that loads a rule still pending delivery drops it and records
`approval-rule.undelivered` in the audit log. A refused or failed decision whose undo cannot
be saved leaves at most its receipt, checkpoint row and a pending rule in the state file, never
an active rule, and the next save that lands removes them. That holds for a decision that was
never sent. When the save that makes a delivered rule active reports failure, the Allow was
sent once and the rule stays pending in memory, but a rejected save is not proof that no
active rule reached the state file: a save can fail after writing, and a restart then loads
the rule active. A later whole save that lands rewrites it as pending, which the next load
drops. The answer is `-32014` with "Domovoi sent this Allow once, but could not confirm the
standing rule was saved. It may or may not be in force after Domovoi restarts. Check Standing
approval rules in Settings, Permissions and rules." The
daemon then stops the server,
so no approval it kept in memory stays in place, and every other session on it reconnects to a
new server on its next message. An abort the server does not confirm also stops the server.
The stopped session's provider session is never resumed: it continues only after the person
restarts its provider thread, which starts a new one. The daemon now starts the OpenCode and
Kilo servers itself, on POSIX under a keeper that holds their process group, and starts no
other server for that provider until a stop has confirmed the old one's processes are gone; a
server it cannot confirm gone is stopped again on each new message, which is refused with
plain recovery steps until the processes are confirmed gone or the person restarts Domovoi. On
Windows a stop is confirmed only by the first `taskkill /T` succeeding while the server's first
process runs, followed by its exit; a first process that exits before any `taskkill`, or any
`taskkill` that fails, leaves the stop unconfirmed until Domovoi restarts. A permission
answer with no outcome within 10 seconds counts as unknown. The session view tells
the person to review the session's changes, because the server lets the approved call run
before the daemon hears of the reply. The desktop setup steps show the same incident for that
provider and do not offer to finish setup, instead of reporting the provider ready.
