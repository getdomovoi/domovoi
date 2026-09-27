---
"@getdomovoi/daemon": patch
---

`updateDaemonService` reports the new outcome `runtime-copied` when, on systemd or for a WSL guest, the staged runtime was published and then failed its check before anything about the service changed: "Domovoi could not update the service: <detail>. The new runtime was copied to <copy>, but the service was left as it was and still runs the previous runtime." A publish that fails itself on systemd still reports `nothing-changed`. launchd and the Windows task publish after the previous service was stopped, so there the previous service is put back as a failed swap.
