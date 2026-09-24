---
"@getdomovoi/daemon": minor
---

Add `updateDaemonService({ runtime })`, which moves an installed per-user service to the Node and
daemon the app now ships, in place. The runtime is checked first and nothing changes before that
passes. launchd boots the agent out, holds the profile while it writes the new agent, then boots
it in; systemd writes the new unit, reloads and restarts it; the Windows logon task is stopped,
the profile held while it lets go, and the task registered again with the new command and run.
A WSL guest service retires its old task, saves the new guest runtime with the profile held, and
registers and starts a task for it. If any step fails, the previous service is put back and
started, and the error says which way that went.
