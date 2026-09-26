---
"@getdomovoi/daemon": minor
---

`@getdomovoi/daemon` exports the service installer for the desktop: `installDaemonService({
runtime: { nodePath, daemonEntryPath }, environment? })`, `readDaemonServiceStatus()` and
`removeDaemonService()`, with their result types. The caller names the Node executable and the
daemon entry it ships; the service (launchd agent, systemd user unit or Windows logon task) runs
those. A missing, relative or non-file runtime path is refused with
`DaemonServiceRuntimeMissingError` before the profile is claimed or any file is written.

`installDaemonService` also takes `releaseInAppDaemon`, called once the runtime, platform and
configuration checks pass and the service-operation lease is held, and before the profile is
claimed, so a refused install never stops the desktop's in-app daemon. A rejected release stops the
install with nothing claimed or written. The profile is checked first: it must be free, or owned by a
desktop owner, the in-app daemon the handoff stops; any other owner refuses with
`ProfileAlreadyOwnedError` before the handoff. If another daemon takes the profile after the handoff,
the install fails with `DaemonServiceHandoffError`, nothing claimed or written.

`readDaemonServiceStatus`, `removeDaemonService`, `domovoid service status` and
`domovoid service remove` treat a Windows task under Domovoi's name as Domovoi's only when
`service.json` holds a Domovoi registration and the task runs that file through exactly the runtime
and daemon entry `service.json` records (`serviceRuntime`, now written by every install that names a
runtime). Any other task is reported as not installed and is neither stopped nor deleted
(`WindowsTaskNotDomovoiError`). An install from before that record stays removable only when it runs
`node.exe` on an `@getdomovoi\daemon\dist\index.js` or `apps\daemon\dist\index.js` entry.

On macOS and Linux, status and removal from both entry points report or stop a job named for
Domovoi only when Domovoi's plist or unit file is there, and on macOS only when `launchctl` says the
job was loaded from that plist. With no such file, status reports nothing installed or running and
removal asks no service manager to stop anything.

The Windows logon task, from the desktop and from `domovoid service install` alike, always runs the
daemon entry through the named Node runtime, and a runtime, entry or configuration path that
contains a percent sign is refused (`WindowsTaskPercentSignError`), because Task Scheduler expands
`%NAME%` when the task runs. A path that contains `$(` is refused (`WindowsTaskArgumentVariableError`),
because Task Scheduler substitutes `$(Arg0)` and the like in task arguments. A path that is not in the plain form
Windows reports (`.` or `..` parts, doubled or forward slashes, a DEL character) is refused
(`WindowsTaskPathError`), because Domovoi could not recognise that task later. Install refuses a
same-named task Domovoi did not register (`WindowsTaskNotDomovoiError`) rather than replace it.

When the service manager refuses the new definition (`schtasks /create`, `launchctl bootstrap` or
`systemctl daemon-reload`), or a service file cannot be written, install puts the previous
`service.json` and service file back, or removes them when there were none, so the record still
names what the manager runs. On macOS, when the install had booted out Domovoi's idle job and the
new agent then fails to bootstrap, the previous agent is loaded again. On macOS,
install boots out an idle job loaded from Domovoi's plist before bootstrapping the new one, and
refuses before the handoff when the label is loaded from another plist (`LaunchdJobNotDomovoiError`).
