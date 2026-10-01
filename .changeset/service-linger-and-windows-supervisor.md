---
"@getdomovoi/daemon": minor
---

Keep the Linux login service running while its person is away, as decided on 2026-09-17, and
harden the Windows logon task.

On Linux, `domovoid service install` turns lingering on with `loginctl enable-linger` when it is
off, says so, and records `"lingerEnabledByDomovoi": true` in `service.json`. Lingering that was
already on is left alone and recorded as `false`. `domovoid service remove` turns lingering off only
on `true`. When `loginctl` is missing or refuses, the install still succeeds, records nothing, and
says on stderr that the daemon stops at logout and starts again at the next login. The desktop's
install and removal return what they did as `linger`.

On Windows, the logon task still runs the daemon itself and has no crash supervision yet; that
returns with the job-object work. Each registration now lifts Task Scheduler's default 72 hour
execution limit and battery stops, as the WSL task does, so the daemon is not ended after three
days or on battery. Install, update, restore and the desktop's runtime readers now run the
`schtasks.exe` under `SystemRoot`, from its own directory, instead of one found by name, which
could have been a repository's own.

Updating a WSL guest service from the app no longer retires the registration it registers again,
so the new guest loop, or a restored one, starts instead of refusing as stopped for removal.
