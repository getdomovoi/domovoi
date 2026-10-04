---
"@getdomovoi/daemon": patch
---

OpenCode and Kilo subagents now run under Domovoi approvals, and current servers' approval
requests reach Domovoi at all. A subagent the `task` tool starts keeps only its parent's deny
rules, so the built-in `general` and `explore` agents ran shell commands and edits with no
approval card, and the adapter dropped every event from a session it had not created.

Every agent now asks before it edits, runs a command, fetches or leaves the project, through a
top-level `permission` block in the inline OpenCode and Kilo configuration. The adapter follows a
subagent session from its `session.created` event to the Domovoi thread that started it, raises
its approval requests on that thread's turn, answers them on the subagent session, and shows its
commands and file changes in the thread. A subagent finishing does not end the turn.

OpenCode 1.18 and Kilo 7.7 send approval requests as `permission.asked`, which the adapter did not
handle, so a Build turn that needed an approval waited forever. Both `permission.asked` and the
older `permission.updated` are handled. A Kilo event that carries no properties, such as `sync`, no
longer ends the event stream and fails the turn.
