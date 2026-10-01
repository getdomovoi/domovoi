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
`provider.approval-answered-elsewhere` in the audit log. The daemon then stops the server,
so no approval it kept in memory stays in place, and every other session on it reconnects to a
new server on its next message. An abort the server does not confirm also stops the server.
The stopped session's provider session is never resumed: it continues only after the person
restarts its provider thread, which starts a new one. The daemon now starts the OpenCode and
Kilo servers itself, on POSIX under a keeper that holds their process group, and starts no
other server for that provider until a stop has confirmed the old one's processes are gone; a
server it cannot confirm gone is stopped again on each new message, which is refused with
plain recovery steps until the processes are gone or the person restarts Domovoi. A permission
answer with no outcome within 10 seconds counts as unknown. The session view tells
the person to review the session's changes, because the server lets the approved call run
before the daemon hears of the reply.
