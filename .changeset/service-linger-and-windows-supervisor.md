---
"@getdomovoi/daemon": minor
---

Keep the login service running while its person is away, as decided on 2026-09-17.

On Linux, `domovoid service install` turns lingering on with `loginctl enable-linger` when it is
off, says so, and records `"lingerEnabledByDomovoi": true` in `service.json`. Lingering that was
already on is left alone and recorded as `false`. `domovoid service remove` turns lingering off only
on `true`. When `loginctl` is missing or refuses, the install still succeeds, records nothing, and
says on stderr that the daemon stops at logout and starts again at the next login. The desktop's
install and removal return what they did as `linger`.

On Windows, the logon task now runs the supervisor loop the WSL guest runs
(`domovoid --service-supervise`). A daemon's exit on Windows does not prove that what it started
has ended, so a crash is recorded, the daemon is not restarted, and `service status` exits 1;
restarting waits for a job object that contains its tree. Removal and updates stop the loop and
prove the daemon stopped before Task Scheduler stops the task, and refuse, keeping the task and
configuration, when the daemon's process tree could not be confirmed ended. Installing over a supervised task
whose loop still runs is refused with the remedy. A task installed earlier keeps working and is
replaced at the next install or update. Each registration then lifts Task Scheduler's default
72 hour execution limit and battery stops, as the WSL task does, so the loop is not ended after
three days or on battery.

Updating a WSL guest service from the app no longer retires the registration it registers again,
so the new guest loop, or a restored one, starts instead of refusing as stopped for removal.
