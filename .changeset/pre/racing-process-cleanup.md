---
"@getdomovoi/daemon": patch
---

Wait for a killed process to exit before treating what it held as free.

Session archive killed the session's terminals and then removed the worktree without waiting. A
pty shell keeps that worktree as its working directory until it actually exits, so the removal
raced a dying shell, which Windows refuses outright while a handle is still open. Archive now
observes each closed terminal's exit before removing the worktree, under the existing agent
timeout, and reports a terminal whose exit it could not confirm.

The Codex stdio transport reported its close as soon as it sent SIGKILL rather than when the
app-server exited, so a shutdown could claim a stopped provider and a reconnect could start a
replacement alongside a process that still held the workspace. The close now waits for the real
exit after the kill, bounded by the same shutdown grace, which is the pattern the ACP transport
already uses.
