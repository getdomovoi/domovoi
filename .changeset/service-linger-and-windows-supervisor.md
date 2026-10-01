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
(`domovoid --service-supervise`). A crashed daemon restarts after 1, 5 and 15 seconds; a fourth
crash is recorded as exhausted and `service status` then exits 1. Removal and updates stop the loop
and prove the daemon stopped before Task Scheduler stops the task. Installing over a supervised task
whose loop still runs is refused with the remedy. A task installed earlier keeps working and is
replaced at the next install or update. Each registration then lifts Task Scheduler's default
72 hour execution limit and battery stops, as the WSL task does, so the loop is not ended after
three days or on battery.

Updating a WSL guest service from the app no longer retires the registration it registers again,
so the new guest loop, or a restored one, starts instead of refusing as stopped for removal.
