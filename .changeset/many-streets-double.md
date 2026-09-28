---
"@getdomovoi/daemon": patch
---

Stopping a Claude session now waits for the Claude process to exit. Domovoi starts that process
itself, through the Claude Agent SDK's `spawnClaudeCodeProcess` option, with the settings the SDK's
own spawn uses. A stop closes the input and the query, then waits up to 2 seconds for the process to
exit. If it has not, Domovoi sends SIGKILL to its whole process group and waits up to 5 seconds
more. On POSIX the process starts in its own process group, so the kill also reaches the commands
its tools started. Windows has no process groups, and there the kill reaches the Claude process
alone.

If the process still runs after the kill, the stop fails. Closing a project then leaves the session
failed, and it refuses new messages until it is recovered. Recovery also fails while that process
runs. A daemon stop fails too, and keeps the profile lease. Before, a stop returned at once. The
session was saved idle, and a later message could start a second Claude query in the same worktree
while the first still ran, even under a new daemon on the same profile.

A stop asked for again while Claude is stopping waits for the same exit, and a Claude conversation is
not reopened while its previous process still runs.
