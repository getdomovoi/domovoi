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

Before Claude, the keeper starts a second member of the group, the sentinel: `/bin/sh` with no
environment, which reads one line from its own pipe to Domovoi and then sends SIGKILL to its own
group. If the keeper dies on its own, for example because something sent it SIGKILL, Domovoi does
not treat Claude as exited, and a stop asks the sentinel to kill the group. The sentinel also kills
the group when Domovoi goes away and its pipe closes. If the sentinel has died too, nothing is
signalled and the stop fails. Claude then stays listed, and the profile lease stays held, until
signal 0 finds no process left in the group. If the sentinel cannot start, the keeper does not start
Claude.

On Windows a stop first runs `taskkill /PID <pid> /T /F` on Claude's process tree, while Claude
still runs, because once Claude has exited taskkill can no longer find the processes it started.
Claude gets no time to finish writing its transcript. Once taskkill has finished, Domovoi kills
Claude through its own process handle if it still runs, closes the input and the query, and waits
up to 5 seconds from the start of the stop for Claude to exit. If taskkill cannot start or reports a
failure, the stop fails, and every later stop of that process fails too: once Claude has exited,
nothing can say whether the processes it started have ended.

A Claude process that exits on its own, before any stop, gets no taskkill, because its pid can name
another process by then. Its exit alone no longer counts as the end of what it started. As it exits,
Domovoi runs PowerShell with fixed arguments, no shell and no window, and lists with
`Get-CimInstance Win32_Process` the processes whose parent pid was Claude's, with their creation
times. It keeps those created after Domovoi started Claude and before it saw Claude exit, which
leaves out processes started by an earlier or later process with the same pid. It runs
`taskkill /PID <pid> /T /F` on each of them, never on Claude's own pid, then lists them again. Only a
list that shows none of them left confirms that they have ended. If PowerShell cannot start, fails,
takes more than 15 seconds, or prints anything but that list, or a process is still listed after its
taskkill, what Claude started stays unconfirmed: the stop fails, and every later stop and daemon stop
fails too, as after a failed taskkill. A stop waits for the list within its 5 seconds, and a list
that confirms later still ends a daemon's wait for that process. This list reaches Claude's direct
children and their trees.
It does not reach a process whose parent, started by Claude, had already exited.

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
