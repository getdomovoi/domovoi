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
record is read only as a private regular file that matches the saved registration. An install now
records the Node executable and daemon entry it installed in service.json (`serviceRuntime`), and
an update records the new ones once they are written, or for a WSL guest once the new service
reports ready. The previous plist, unit, task action or WSL guest runtime is put back only in the
shape a Domovoi install writes (absolute runtime and daemon entry, then the saved configuration
path) and only when its runtime and entry are exactly the ones service.json records. Anything
else, and any install whose service.json has no such record, is refused before anything changes,
with the outcome `changed-outside`: "The installed service file was changed outside Domovoi, so
Domovoi will not update it. Remove the service and install it again to replace it." A service
that is not installed keeps the outcome `not-installed` and its own words.

On macOS the update and its restore boot out a job under Domovoi's label only when `launchctl`
says it was loaded from Domovoi's plist; a job from another plist refuses the update with nothing
changed (`LaunchdJobNotDomovoiError`). On Windows an update refuses, with nothing changed, when the
previous task action it would register again contains `%`, `$(` or a path Windows would not report
in that form. A WSL update refuses, with nothing changed, when the old or the new task would carry `%` or `$(`
in its `wsl.exe` path or arguments, and a Linux update refuses when the recorded old runtime or entry
contains `$` or `%`.
