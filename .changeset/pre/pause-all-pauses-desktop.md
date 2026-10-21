---
"@getdomovoi/ui": patch
---

The desktop's "Pause all" sent `system.emergencyStop`: it blocked every provider, aborted the
workspace and killed every terminal, while its label promised a pause. `system.pauseAll` existed
on the wire and in the client and nothing called it.

The app bar button is now "Stop everything" and opens a menu with two items that each say what
they do. "Pause everything" calls `system.pauseAll` and stops at the next turn boundary; nothing is
killed. "Emergency stop" calls `system.emergencyStop` and says that processes are killed now and
half-written files stay half-written. The command palette lists both commands under the same
names; the old "Pause all" command that sent the kill is gone. The error banner reads "Emergency
stop failed" for the stop it reports.
