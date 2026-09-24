---
"@getdomovoi/daemon": patch
---

An interrupted turn's late end no longer completes the turn sent after it. The Claude Code and
OpenCode adapters (Kilo shares the OpenCode one) kept one active turn per thread and ended whichever
turn held it when a completion arrived. Stop returns once the provider acknowledges the interrupt,
and the interrupted turn's own result or idle comes after that, so a message sent in the gap was
recorded as finished at once while the provider kept working on it, and its reply was dropped.

Claude Code: a result that names only the user messages of an interrupted turn
(`user_message_uuid`, `user_message_uuids`) is that turn's and ends nothing. Any other result ends
the active turn as before, including one naming a message the SDK made itself or naming none.
OpenCode and Kilo: after an interrupt, the first `session.idle` or `session.error` that comes before
the next turn's own messages is the interrupted run's and ends nothing, since the server finishes
an aborted run before it takes the next prompt. Without an interrupt, the first idle or error ends
the turn as before.
