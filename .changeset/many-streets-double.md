---
"@getdomovoi/daemon": patch
---

Stopping a Claude session now waits for the Claude process to exit. Domovoi starts that process
itself, through the Claude Agent SDK's `spawnClaudeCodeProcess` option, with the settings the SDK's
own spawn uses. The Claude process that lists models is started the same way.

On POSIX a stop closes the input and the query, then waits up to 2 seconds for the process to
exit, then kills what it started, and waits up to 5 seconds more for Claude to exit. Domovoi starts
a small Node process, the keeper, in its own process group, and the keeper starts Claude in that
group, which the commands its tools run join. The keeper hands Claude the command, arguments and
environment the SDK built, and passes on the signals the SDK sends. It sends SIGKILL to the group
when Claude exits, whether it exits on its own or after the grace, or when a stop asks it to, so no
command a session started outlives it. Domovoi never signals the group by number, because once the
group's last process has gone that number can name another group. After the keeper has gone,
Domovoi checks the group with signal 0 until no process is left in it. A command that moves itself
to a new session or process group is out of reach.

On Windows a stop first runs `taskkill /PID <pid> /T /F` on Claude's process tree, while Claude
still runs, because once Claude has exited taskkill can no longer find the processes it started.
Claude gets no time to finish writing its transcript. Once taskkill has finished, Domovoi kills
Claude through its own process handle if it still runs, closes the input and the query, and waits
up to 5 seconds from the start of the stop for Claude to exit. A Claude process that exited before
the stop began gets no taskkill, because its pid can name another process by then. If taskkill
cannot start or reports a failure, the stop fails, and every later stop of that process fails too:
once Claude has exited, nothing can say whether the processes it started have ended.

If the process still runs after the kill, or a process it started is not known to have ended, for
example because it refused the kill, the stop fails. Closing a project then leaves the session
failed, and it refuses new messages until it is recovered. Recovery stops the failed process before
it starts a replacement or takes a checkpoint, and fails while that process runs. An emergency stop
tries every earlier failed stop again, and reports each one until its process has exited. Before, a
stop returned at once. The session was saved idle, and a later message could start a second Claude
query in the same worktree while the first still ran, even under a new daemon on the same profile.

A daemon stop fails too, and keeps the profile lease. A start that was still preparing when the
stop began starts no Claude, and a model list still starting or listing is stopped, and its Claude
process waited for, like a session's. Once a daemon stop has succeeded, no later start runs Claude.
When SIGINT or SIGTERM stops a foreground daemon and a Claude process, or a process it started, is
not known to have ended, the daemon prints the pid and Claude session, keeps running and keeps the
profile lock, and exits once the process has ended. The second SIGINT exits at once, after a warning
that the lock is released while the process may still run, even when it came while the daemon was
still stopping. SIGTERM does not, and does not count toward the second SIGINT.

A stop asked for again while Claude is stopping waits for the same exit, and a Claude conversation is
not reopened, or reported loaded, while an earlier process for it still runs.
