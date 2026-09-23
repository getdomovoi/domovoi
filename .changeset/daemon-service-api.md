---
"@getdomovoi/daemon": minor
---

`@getdomovoi/daemon` exports the service installer for the desktop: `installDaemonService({
runtime: { nodePath, daemonEntryPath }, environment? })`, `readDaemonServiceStatus()` and
`removeDaemonService()`, with their result types. The caller names the Node executable and the
daemon entry it ships; the service (launchd agent, systemd user unit or Windows logon task) runs
those. A missing, relative or non-file runtime path is refused with
`DaemonServiceRuntimeMissingError` before the profile is claimed or any file is written. The CLI's
`domovoid service` is unchanged.
