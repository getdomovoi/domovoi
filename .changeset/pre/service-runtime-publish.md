---
"@getdomovoi/daemon": patch
"@getdomovoi/desktop": patch
---

`installDaemonService` and `updateDaemonService` take a `staged` runtime: its files are checked first, and its `publish` step runs only under the service-operation lease, after every profile check and before the handoff or any manager action. The desktop prepares an inert copy in a hidden directory under the profile, hands it over, and discards any copy the service call did not publish, so a refused change leaves every file as it was. While it copies and publishes, the desktop requires the profile's runtime directory to stay the directory it checked, by device, inode and real path, and writes nothing more when it changed.
