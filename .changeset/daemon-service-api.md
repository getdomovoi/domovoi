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
install with nothing claimed or written.

`readDaemonServiceStatus`, `removeDaemonService`, `domovoid service status` and
`domovoid service remove` treat a Windows task under Domovoi's name as Domovoi's only when
`service.json` holds a Domovoi registration and the task runs that file through exactly the runtime
and daemon entry `service.json` records (`serviceRuntime`, now written by every install that names a
runtime). Any other task is reported as not installed and is neither stopped nor deleted
(`WindowsTaskNotDomovoiError`). An install from before that record stays removable only when it runs
`node.exe` on an `@getdomovoi\daemon\dist\index.js` or `apps\daemon\dist\index.js` entry.

The Windows logon task, from the desktop and from `domovoid service install` alike, always runs the
daemon entry through the named Node runtime, and a runtime, entry or configuration path that
contains a percent sign is refused (`WindowsTaskPercentSignError`), because Task Scheduler expands
`%NAME%` when the task runs.
