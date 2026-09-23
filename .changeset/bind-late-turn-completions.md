---
"@getdomovoi/daemon": patch
---

An interrupted turn's late end no longer completes the turn sent after it. The Claude Code and
OpenCode adapters (Kilo shares the OpenCode one) kept one active turn per thread and ended whichever
turn held it when a completion arrived. Stop returns once the provider acknowledges the interrupt,
and the interrupted turn's own result or idle comes after that, so a message sent in the gap was
recorded as finished at once while the provider kept working on it, and its reply was dropped.

Claude Code results that name the user messages they answered (`user_message_uuid`,
`user_message_uuids`) complete a turn only when one of them is that turn's prompt or steering;
results from older producers that name none are taken as before. OpenCode and Kilo end a turn on
`session.idle` or `session.error` only after the server has shown that turn's own messages, since
the server finishes an aborted run before it takes the next prompt.
