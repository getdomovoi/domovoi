---
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
---

Stop an OpenCode or Kilo session when its server reports an approval reply the daemon did
not send. Both servers read their password only from their startup environment, which every
program they start can read as the same user. The daemon now records each reply before it
sends it. Any other reply aborts the run, fails the session with `approval-answered-elsewhere`,
refuses every request still waiting, unloads the thread, holds a queued send, and records
`provider.approval-answered-elsewhere` in the audit log. The next message resumes the thread.
The session view tells the person to review the session's changes, because the server lets
the approved call run before the daemon hears of the reply.
