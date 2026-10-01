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
`provider.approval-answered-elsewhere` in the audit log. The daemon then restarts the server,
so no approval it kept in memory stays in place, and every other session on it reconnects on
its next message. A stop the server does not confirm ends the server and the programs it
started. The stopped session's provider session is never resumed: it continues only after
the person restarts its provider thread, which starts a new one. The daemon now starts the
OpenCode and Kilo servers itself, each leading its own process group. The session view tells
the person to review the session's changes, because the server lets the approved call run
before the daemon hears of the reply.
