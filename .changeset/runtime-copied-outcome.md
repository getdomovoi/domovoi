---
"@getdomovoi/daemon": patch
---

`updateDaemonService` reports the new outcome `runtime-copied` when, on systemd or for a WSL guest, the staged runtime was published and then failed its check before anything about the service changed: "Domovoi could not update the service: <detail>. The new runtime was copied to <copy>, but the service was left as it was and still runs the previous runtime." On systemd and for a WSL guest the update waits for the publish rather than cutting it short at its deadline, and answers by what happened to the copy: a copy published while the deadline expired is `runtime-copied` too, and a publish that fails, or that never started because the deadline had expired, reports `nothing-changed` with no restore. launchd and the Windows task publish after the previous service was stopped, so there the previous service is put back as a failed swap.
