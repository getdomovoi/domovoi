---
"@getdomovoi/daemon": minor
---

Add `updateDaemonService({ runtime })`, which moves an installed per-user service to the Node and
daemon the app now ships, in place. The runtime is checked first and nothing changes before that
passes. launchd boots the agent out, holds the profile while it writes the new agent, then boots
it in; systemd writes the new unit, reloads and restarts it; the Windows logon task is stopped,
the profile held while it lets go, and the task registered again with the new command and run.
A WSL guest service records its intent, retires its old task, saves the new guest runtime with
the profile held, and registers and starts a task for it. A start counts only once the daemon
reports ready. If any step fails, a timeout included, the previous service is put back under its
own time budget and must report ready too; the error says which way that went, or that nothing
was changed. The saved configuration is read under the service-operation lease, a restore waits
for any write still pending, an unreadable owner record fails the update, and the WSL update
record is read only as a private regular file that matches the saved registration. The previous
plist, unit, task action or WSL guest runtime is put back only in the shape a Domovoi install
writes (absolute runtime and daemon entry, then the saved configuration path); any other shape is
refused as no Domovoi service before anything changes.
