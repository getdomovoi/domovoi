---
"@getdomovoi/daemon": patch
---

Refuse overlapping service install, status and removal commands using a separate per-OS-user
operation lease held across file and manager steps. Changing the shell's home cannot bypass it.
The daemon can still take its own profile lease while installation waits for startup. A refused
command names the lease and asks the operator to retry after the active command finishes.

The existing deadline remains shared across the whole operation. After a timeout the lease stays
held until the CLI exits. A killed or timed-out CLI does not prove a native manager cancelled its
job; inspect the manager and saved configuration before retrying. No credentials are changed.
