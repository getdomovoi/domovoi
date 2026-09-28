---
"@getdomovoi/daemon": patch
---

Stopping a Claude session now waits for the Claude process to exit. Domovoi starts that process
itself, through the Claude Agent SDK's `spawnClaudeCodeProcess` option, with the settings the SDK's
own spawn uses. The Claude process that lists models is started the same way. A stop closes the
input and the query, then waits up to 2 seconds for the process to exit, then kills what it
started, and waits up to 5 seconds more for Claude to exit.

On POSIX Claude starts in its own process group, which the commands its tools run join. Domovoi
sends SIGKILL to that group when Claude exits, whether it exits on its own or after the grace, so
no command a session started outlives it. A command that moves itself to a new session or process
group is out of reach. On Windows Domovoi runs `taskkill /PID <pid> /T /F` on Claude's process tree
after the grace. Once a Windows Claude process has exited on its own, its pid can name another
process, so Domovoi sends no taskkill then, and the commands it left are not killed.

If the process still runs after the kill, the stop fails. Closing a project then leaves the session
failed, and it refuses new messages until it is recovered. Recovery stops the failed process before
it starts a replacement or takes a checkpoint, and fails while that process runs. An emergency stop
tries every earlier failed stop again, and reports each one until its process has exited. Before, a
stop returned at once. The session was saved idle, and a later message could start a second Claude
query in the same worktree while the first still ran, even under a new daemon on the same profile.

A daemon stop fails too, and keeps the profile lease. A start that was still preparing when the
stop began starts no Claude. When SIGINT or SIGTERM stops a foreground daemon and a Claude process
will not exit, the daemon prints that process's pid and Claude session, keeps running and keeps the
profile lock, and exits once the process has exited. A second SIGINT exits at once, after a warning
that the lock is released while the process may still run. SIGTERM does not.

A stop asked for again while Claude is stopping waits for the same exit, and a Claude conversation is
not reopened, or reported loaded, while an earlier process for it still runs.
