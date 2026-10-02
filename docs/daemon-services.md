# Daemon service configuration

`domovoid service install` installs a per-user systemd unit, launchd agent, or Windows logon task.

Inside WSL 2 with Windows interop enabled, the command instead registers the
decided Windows-logon task running the guest supervisor. The distribution comes
from `WSL_DISTRO_NAME`, the Linux user from the invoking process, and the runtime
and entry point are absolute paths. PowerShell discovery ignores PATH. The fixed
`/usr/bin/wslpath` helper translates
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` to its mounted guest
path, normally `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`.
An explicit `DOMOVOI_WINDOWS_POWERSHELL` override must be an absolute guest path.
Both paths must name an existing regular file before execution; the reported
SystemRoot must then translate back to the same PowerShell path before any task
or registration is created. The override is an operator-selected executable,
not executable authentication. The default trusts the system-managed Windows
mount, not a project PATH entry. Missing interop, a missing/non-regular file or
a mismatched SystemRoot refuses installation, without falling back to systemd
or editing distro init.

The guest's per-user `service.json` retains the WSL launch inputs and selected
profile. Status and removal use that saved registration even without the shell's
WSL/profile overrides. Removal disables the owned task, proves the guest loop and
children stopped with retries cancelled, then deletes the task and registration.
Profile data and supervisor history remain. Missing guest identity or failed stop
proof retains the registration; a missing task alone never authorizes recovery.
Remove an existing registration before reinstalling. Interrupted installation can
require operator reconciliation if no supervisor identity was ever recorded.

Known limit (ruling Q311 A, read from source, not tested): a WSL update from the
app stops the guest loop the way removal does, which retires the supervisor
registration, then registers the same registration ID again. The new guest
supervisor refuses to start for a retired registration, so the new service
never reports ready. The restore registers the old task under that same ID, and
it refuses too, so the update fails and says the service is not running.
Starting the task by hand does not help, because the retirement still names that
ID; remove the service and install it again, which issues a new ID. A separate
PR will fix this with per-start IDs and a start fence held through cleanup.

This is Windows user logon, not Windows boot supervision. The guest loop is not
self-restarting after distro or loop loss. A demand-start fixture does not
establish real logon acceptance; that remains open in the lifecycle assessment.
The native Windows logon task has no crash supervision yet
([Windows logon task](#windows-logon-task)), and a Linux install turns
lingering on ([Linux lingering](#linux-lingering)).

It captures the current daemon configuration before asking the service manager to start anything.
Close other daemon owners, including Desktop, before starting the service, then reopen Desktop to
attach. See [local daemon ownership](local-daemon-ownership.md) for the attachment contract.
Existing installations need one reinstall to replace their old launch command; upgrading the binary
alone does not rewrite service-manager configuration.

The installer writes `<user-home>/.domovoi/service.json`. The installed command names the Node
runtime, daemon entry point, and `--service-config <path>` explicitly. On startup the production
factory receives the saved settings, not daemon variables inherited from the supervisor.
Windows installation refuses command lines over 262 characters before writing files; use shorter
absolute installation paths rather than a truncated launch command.

The versioned file contains a fresh installation registration UUID, listener host and port,
remote-listener opt-in, TLS certificate and key
**paths**, advertised host, allowed browser origins, credential and machine-identity paths, and the
real user home for provider processes and the explicit profile directory for durable state.
Relative per-file input paths become absolute against the installing
shell's working directory. The default paths and port are captured too, so a changed environment
cannot silently choose a different identity or endpoint after a restart.

Set `DOMOVOI_PROFILE_DIR` to an absolute directory before installation to select a profile.
Its leases, owner records, credentials, identity, database, logs and worktrees use that directory;
provider CLIs keep the real home and sign-ins. Saved configurations predating this setting use
`<saved-home>/.domovoi`. The invoking shell cannot override a saved profile at startup.

Registration remains at `<user-home>/.domovoi/service.json`, and the service-operation lease
remains shared per OS user. There is still one native service job per user, not one per profile.
Status and removal find the installed profile from that registration even with no shell override.
Installing a different profile first requires the previous registered profile's lease to be free;
changing directories cannot bypass a running owner. Registration blocks interactive fallback
only for its selected profile; unreadable registration conservatively blocks fallback.

No bearer, TLS key contents, provider credentials, or arbitrary shell environment are serialized.
An install with `DOMOVOI_AUTH_TOKEN` set refuses before writing files or invoking the manager.
Use an existing private credential file via `DOMOVOI_CREDENTIAL_PATH`, unset the environment bearer,
then install again. If no file exists, the daemon creates its normal file credential when it starts.
The installer does not copy, rotate, or mint credentials. Changing to a different credential is an
operator decision, not an automatic migration.

Service files and their immediate parent directories are set to modes `0600` and `0700` on Unix,
including pre-existing entries. Windows uses the user directory's inherited ACLs. These files hold
settings and secret paths, not secret contents.

Saved configurations are limited to 64 KiB, reject unknown fields, and must satisfy the same
listener and origin validation as an interactive daemon. A missing, malformed, incompatible, or
unreadable file refuses startup and names the file. There is no fallback to default settings.
Loading has a five-second deadline. Service install, status, and removal each share one 30-second
deadline across filesystem and manager steps; an expired step cannot initiate a later step.

## Concurrent commands

Install, status and removal first acquire an exclusive operation lease. A competing command fails
immediately, before reading service state, changing files or invoking the manager. Its error names
the lease file and asks the operator to wait for the active command, then retry. Status does not
combine a file observation from before an installation with a manager reply from after it.

The lease is `<OS-user-home>/.domovoi/service-operation-lease.sqlite`, separate from both the runtime
profile lease and the state database. The OS user lookup supplies this home, not shell `HOME` or
`USERPROFILE`: changing the selected profile cannot create a second lock for the same service name.
Unix sets the parent and file modes to `0700` and `0600`; Windows inherits the user directory ACLs.
This empty SQLite database carries a lifetime exclusive transaction with a zero busy timeout.
Never delete or replace it. File existence is not a held lease, and replacing the inode could let
two commands hold independent locks at the same path.

The operation lease remains held while installation releases the runtime profile lease and asks
the manager to start the daemon. Removal holds it from its initial registration snapshot through
the stop proof, configuration deletion and recovery receipt. Both paths acquire the operation
lease before the runtime lease. The daemon only needs the latter, so it can start while installation
waits for its manager. Normal completion or a settled error releases the operation lease.

Expiry retains the lease until the CLI exits because an OS call can still finish late. The OS
releases it on process exit without timestamps or PID guesses. Neither event proves that a native
manager cancelled an already accepted job. After a killed or timed-out command, inspect the native
manager and saved configuration before retrying. This is concurrent-command exclusion, not
crash-atomic installation or automatic reconciliation of native jobs. The existing profile
registration and receipt checks still apply; the operation lease is not recovery authorization.

To change settings, stop the service, run installation again with the intended environment, then
restart it. Installation does not guarantee that a manager reloads an already running process.
Removal deletes the saved configuration after the manager stops and the profile lease is free.
A corrupt, oversized or unreadable owner record or saved configuration does not block that removal,
but it yields no recovery receipt: the command names the unreadable file and points to
`domovoid profile recover --confirm-no-supervisor` after repair. It does not remove the
credential, identity, workspace database, or worktrees.

## Linux lingering

Decided 2026-09-17 (`SHIP-PLAN.md` S1.1). Without lingering, systemd stops a user's units when that
user's last session ends and starts them again at the next login, so the daemon would stop at
logout. `domovoid service install` on Linux (not inside WSL) therefore asks
`loginctl show-user <uid> --property=Linger --value` first:

- `no`: it runs `loginctl enable-linger <uid>`, saves `"lingerEnabledByDomovoi": true` in
  `service.json`, and prints `Turned on lingering for <user> with loginctl enable-linger, so the
  daemon keeps running after <user> logs out and starts when the machine boots. domovoid service
  remove turns it off again.`
- `yes`: it changes nothing, saves `"lingerEnabledByDomovoi": false`, and prints `Lingering was
  already on for <user>, so Domovoi left it as it was. domovoid service remove will leave it on.`
  A reinstall over a configuration that already says `true` keeps `true` and prints `Lingering for
  <user> stays on from an earlier Domovoi install. domovoid service remove turns it off again.`

Lingering is asked for under the profile lease, before `service.json` is written, so one write
records it. Any other answer is a failure: `loginctl` missing (`loginctl was not found`), a non-zero
exit (its own message), or a value other than `yes` or `no`. A failure records nothing, installs
the service anyway, exits 0, and prints on stderr `Could not turn on lingering for <user>: <reason>.
The service is installed, but systemd stops the daemon when <user> logs out of every session and
starts it again at the next login. To keep it running, run loginctl enable-linger; domovoid service
remove will then leave lingering on.` It warns rather than fails because the service itself works
while the user is logged in, the way the WSL install succeeds and states its own limit (`Windows user
logon only; no boot supervision.`). Every manager step stays fatal, and so does an expired deadline. If a later install step fails and the previous service files are put back, the lingering
this install turned on is turned off again; if that fails too, the error says lingering is still
on.

`domovoid service remove` reads the record before anything changes. Only `true` runs
`loginctl disable-linger <uid>`, after the unit and `service.json` are gone, and prints `Turned off
lingering for <user>, which Domovoi turned on at install.` `false` prints `Lingering for <user> was
on before Domovoi was installed, so it was left on.` No record, or a configuration that cannot be
read, leaves lingering as found and prints nothing about it. A failed `disable-linger` does not undo
the removal; it prints on stderr that lingering stays on and how to turn it off. The desktop's
install and removal do the same and return the outcome as `linger`. When lingering could not be
turned on, the install also returns the CLI's stderr text as `lingerWarning`, and Desktop shows it
under the install result (ruling Q307). Desktop does not show the removal's outcome yet.

Desktop refuses service text over 4,096 UTF-16 units. Before any lingering line is composed,
`loginctl`'s diagnostic is cut to 1,000 code points and the user name to 128, each followed by
`... (shortened)` when cut. The CLI and Desktop print the same bounded line, and the logout limit
and the `loginctl enable-linger` advice always fit (review of #698, round 4).

`loginctl` is run by its bare name and found through `PATH`, as `systemctl` is: `PATH` is trusted
for the Linux service commands. Every call passes the installing user's numeric uid, taken from
the OS, never from `service.json`.

The record is an ownership hint, not proof of who turned lingering on (security review of #698).
`service.json` is a private file of the same user, and the record says what an install saw, not
what has happened since. Two cases follow. A stale `true`, or one written into the file by hand,
makes removal turn lingering off even when Domovoi did not turn on the lingering in force; this
includes lingering turned off and on again by the person after the install, since a reinstall that
finds it on keeps an earlier `true`. And a reinstall whose `loginctl` read fails records nothing,
dropping an earlier `true`, so a later removal leaves on the lingering Domovoi did turn on. Either
case only changes the installing user's own lingering.

## Windows logon task

The limited-user `ONLOGON` task runs the daemon itself with `--service-config`. It has no crash
supervision yet: a daemon that crashes stays down until the next logon or a manual start. The
2026-09-17 decision to give it the WSL guest's supervisor loop was taken out of #698 by ruling
Q300 A (2026-10-01), after review showed that failing closed on Windows needs per-attempt process
tree evidence, a startup gate and boot-based recovery. It returns together with a job object that
contains the daemon's tree.

The task is created by `schtasks /create /sc onlogon /rl LIMITED`, which cannot set a task's run
limit or battery rules and leaves Task Scheduler's defaults: a 72 hour execution limit, as
Microsoft documents it, and battery rules that stop the task. The daemon would end there, with or
without supervision. So after every
`/create`, at install, update and an update's restore, a PowerShell step through the Task Scheduler
COM interface sets what the WSL task sets: `ExecutionTimeLimit` `PT0S` (no limit),
`DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries` false. It registers the change in place
(`TASK_UPDATE`) under the task's own principal and logon type, with no password, before the task
is run. A failure there fails the install after the task was registered, as any step after
`/create` does. Tests check the generated script only; Task Scheduler has not been seen to accept
it.

## Windows removal

`domovoid service remove` disables the logon task before stopping it, waits for Task Scheduler to
report that it is disabled with no queued or running instances, and only then removes the task and
saved configuration. Deleting a registration alone does not stop its running program.
See [schtasks delete](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-delete)
and [RegisteredTask.State](https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-state).

The Windows path uses the built-in Windows PowerShell Task Scheduler COM interface, not localized
`schtasks /query` text. The executable is resolved beneath the absolute local `SystemRoot`, never
from the project directory or `PATH`; a missing or relative OS directory refuses before spawning.
Since the security review of #698 (F3) the same holds for `schtasks.exe` at install, update,
restore and in the desktop's runtime readers, which named it bare before, so a repository's own
`schtasks.exe` could have run. Both tools also run from their own directory, not the caller's.
`SystemRoot` itself is trusted, as the environment that names the Windows directory.
It runs noninteractively without a profile, elevation, execution-policy
bypass, or a task password. Missing or blocked PowerShell refuses removal; there is no delete-only
fallback. Disable, stop, status observations, deletion, and configuration cleanup share the same
30-second deadline. Polling cannot renew it, and a late result cannot start a later deletion.

A missing task at the initial lookup is already removed. Once a task has been found, an unknown
state or disappearing registration is not proof that its process stopped. Manager failures and
stop timeouts retain the configuration; a failure during final deletion may have already changed
OS or filesystem state. The error names the task and asks the operator to inspect Task Scheduler
and the saved configuration before retrying. A failure after the stop step can leave the task
disabled with its registration and configuration kept; the error says so. Re-enable it with
`schtasks /change /tn "Domovoi daemon" /enable` or reinstall with `domovoid service install` if
keeping the service instead of retrying removal. No other process is killed by
name, and a daemon already orphaned by an older delete-only removal needs manual reconciliation.

Task Scheduler termination is not a graceful daemon shutdown and can leave a ready owner record
after the process lease is released. Removal does not clear that record. Instead, when its saved
registration UUID and exact owner instance match before and after the manager stop, removal writes
an owner-only completed-removal receipt while holding the free lease. Desktop can then retire only
that receipt-bound instance. A missing task or configuration cannot authorize an unrelated owner.
Legacy and custom launches without registration proof need the explicit
`domovoid profile recover --confirm-no-supervisor` command after the operator has stopped all
supervisors. The [ownership contract](local-daemon-ownership.md#service-installation-and-recovery)
documents the assertion, receipt lifecycle and failure limits.

## Evidence and remaining limits

Tests round trip one non-default configuration through all three service formats. A distributed-CLI
test intercepts only OS-manager subprocess calls, checks the real files and launch command, then
launches the real daemon with a conflicting environment and authenticates over its saved TLS
endpoint. Removing the CLI environment handoff makes that test recover the default endpoint and
identity paths instead.
The TLS fixture requires `openssl` on the test runner's PATH to generate its temporary certificate.

Concurrency tests hold the manager phase while using real file publication, registration digest
checks and profile leases. A separate test starts two copies of the distributed CLI, intercepting
only the native manager and OS-user home. It checks refusal before any competing file or manager
action, including a different shell `HOME`, then reacquisition after normal completion or a killed
CLI. Removing acquisition makes both process tests fail. Releasing exclusion on expiry makes all
three deadline tests fail. These tests do not exercise native manager jobs after a CLI crash.

Windows removal boundary tests model a live process surviving registration deletion, prove the
stop-before-delete order, and exercise queued, unknown, absent, refused, silent, and late replies.
The native Windows-only test creates a UUID-named limited-user task, observes its live Node process,
runs the real removal subprocesses, and requires both process exit and an absent registration.
It never replaces the user's Domovoi task. Its private stop marker cleans up even a deliberately
broken delete-only remover. This test is skipped on other operating systems, so a green Linux run
does not prove native Windows removal.

A native Linux-only test drives systemd itself through the same install, status and removal
functions the CLI calls. It installs a UUID-named user unit into the per-boot runtime unit
directory, checks that the manager loaded that exact fragment, enabled it and started the process
the unit names, then removes it and requires process exit, an absent unit, an absent enable symlink
and an absent saved configuration. It allows only exact `systemctl --user` command shapes for that
UUID unit, with `daemon-reload` the sole manager-wide operation required by the installer. Paths,
wildcards, extra scope flags and other unit types are refused. File effects stay in the private home
except for the exact runtime unit path; traversal and existing symlink components are refused.
Preflight requires a successful manager query reporting absence and no unit or enable entry on
disk, including dangling links. It repeats that check immediately before installation and arms
manager cleanup only when the installation is attempted. A collision or unknown result never
authorizes disabling a unit, resetting its state or deleting its files. That cleanup resets the
attempted unit's failed state, because a run that ends in
failure stays loaded and listed as failed after its fragment file is deleted, and it then requires
the manager to list nothing failed under that name. Outside CI, a machine without the systemd user
manager's private socket skips these native proofs. Linux CI starts that manager, and test
collection itself also refuses a missing socket rather than trusting the earlier workflow check.
A stale socket reaches the bounded manager query and fails instead of being treated as absence.
The same harness has portable safety tests with a simulated manager and real private files; those
tests exercise refusals without risking a pre-existing service on the developer's machine.
Those lifecycle tests script unit text so Windows launch paths do not mask their assertions.
A separate real-renderer test requires POSIX-absolute runtime and temporary paths; native Linux
proofs always use the real renderer and manager.
If cleanup cannot confirm the attempted unit stopped, it retains files rather than leaving a
restartable job pointing at deleted launch input. The error names the UUID unit and paths to
inspect and preserves the original assertion failure alongside the cleanup failure. Stop that
test-owned unit before manually removing retained files. A preflight refusal never authorizes
stopping or deleting the colliding unit.
Once manager cleanup is confirmed, the private fixture home uses the shared
scratch removal helper: held-directory refusals are retried and removal is
verified by absence. That retry is independent of the manager cleanup deadline;
it does not authorize removal when manager ownership or shutdown is unknown.

A second native Linux-only test proves the restart supervision that unit declares. It reads
`Restart` and `RestartSec` back from the manager's parse of the installed unit rather than from the
generated string, kills the unit's main process through the manager with `SIGKILL`, which systemd
does not count as one of the four clean-exit signals, and then requires the manager's own restart
count to reach one alongside a new live main process that wrote the fixture's PID file. Under
`Restart=on-failure` that count moves only for a failure, so it is at once the restart and the
manager's classification of the crash. Two negatives run in the same unit. A deliberate
`systemctl stop` must stay inactive and dead past the restart delay the manager reports, because a
supervisor that fights an operator's stop is its own defect. A main process that exits zero,
asked for through the fixture's private stop path, must also stay exited with the restart count
still at zero; that is the half the `on-failure` directive itself decides. Setting the unit to
`Restart=no` fails the crash half, and `Restart=always` fails the clean-exit half, so the pair pins
the directive from both sides. The test shares the throwaway unit name, the runtime unit path, the
`systemctl` chokepoint, the refusing preflight and the ownership-gated cleanup with the lifecycle test
rather than carrying a second copy of them.

A native macOS-only test drives launchd itself through the same install, status and removal
functions the CLI calls. It bootstraps a throwaway agent into the per-user `gui/<uid>` domain the
installer targets, checks that the domain registered that exact file as a launch agent, that it is
running, and that the process launchd reports is the one that wrote its own PID file, then removes
it and requires process exit, an absent agent, an absent saved configuration and a domain that no
longer answers for the label. Paths are compared resolved rather than as strings, because macOS
reaches a temporary directory through a symlink and launchd answers with the `/private` form of it.
Its label is the production one with a fresh identifier appended, so it cannot collide with the
operator's own agent while still being classified by the daemon's own missing-service matcher.
Bootstrapping names a path rather than a search directory, so every file stays inside a throwaway
home and nothing is written to the operator's own `Library/LaunchAgents`.

Four properties keep that test off the operator's own agents, and each is pinned by a test that
drives the same machinery with a scripted manager, on every platform rather than only on macOS.
It runs `launchctl` and only the command lines it needs: printing, killing and booting out its own
throwaway label, and a bootstrap that names the one plist inside its own home. Anything else is
refused by not being on that list, including a domain wide `bootout gui/<uid>`, which retires every
agent the operator has, and a plist path in their real `Library/LaunchAgents`. It refuses to
overwrite a label that already exists, and it counts a manager it cannot read as unknown rather
than as absence. The removal in its cleanup is armed only once launchd has said the label is
unused, and only immediately before the bootstrap that can leave one behind, so a run that refuses
at the preflight asks launchd to retire nothing. Its gate is that domain, so a session without one,
such as a plain ssh login, skips; the probe that reads it is bounded, because it runs before any
test deadline applies. On CI that gate throws instead of skipping. The macOS leg asserts the same
domain before the suite and refuses to run as uid 0, and the test file refuses to skip there as
well, because a skipped macOS leg reports exactly like a passing one. One further check, that the
bootstrap command line the installer really emits is admitted by that allowlist, needs an install
which reaches the manager, so it runs only where a temporary directory is posix absolute. A Windows
one is not, and no spelling would satisfy both halves of the daemon, which builds darwin service
paths with posix joins and the local owner receipt beside them with the platform join.

A second native macOS-only test proves the supervision the agent declares. It reads launchd's own
relaunch throttle back off the manager, crashes the process through the manager with
`launchctl kill SIGKILL`, and requires launchd's own run count to increment alongside a new live
process that rewrote the fixture's PID file. That counter, not a changed process id, is what says
launchd started the replacement, and it is the counterpart of the systemd unit's `NRestarts`. The
negative half is what pins `SuccessfulExit` false rather than a bare `KeepAlive`: a process that
exits zero through the fixture's private stop path must stay exited past the throttle window with
the run count unmoved. Two launchd behaviours are handled rather than left to flake. Booting out is
asynchronous, so the domain is polled until it stops answering instead of sampled once. A throttled
relaunch is reported as `spawn scheduled` rather than as absent, so the no-relaunch half excludes
that state as well as `running`.

Both macOS native tests ran successfully on 2026-09-11. The
[macOS main CI job](https://github.com/getdomovoi/domovoi/actions/runs/34635457431/job/103382119331)
at `98c412c540bad49b9cbf2459a47bc3309cda62b8` reports nine tests in
`service/launchd-agent.native.test.ts`, including these two native proofs, with no skips.
The [Linux job from that run](https://github.com/getdomovoi/domovoi/actions/runs/34635457431/job/103382119025)
also reports both native systemd tests passing. These tests use throwaway fixture processes;
they establish the manager lifecycle and crash/clean-exit policies, not host reboot acceptance or
production-daemon state recovery. The earlier claim that macOS remained unexecuted understated
what was built and proved, inviting duplicated work. The
[S1.1 assessment](service-lifecycle-assessment.md) records the platform gaps and WSL options.

macOS status reads the job's own runtime `state` from
`launchctl print gui/<uid>/<label>`. Only `running` reports a live job; a loaded agent whose
process exited or is waiting for a scheduled spawn remains installed but reports not running.
The crash-supervision test also checks status after a clean exit. A missing or ambiguous runtime
field is a refusal, as is any command failure other than the missing-service answer (113).

Windows status uses the numeric Task Scheduler `RegisteredTask.State` through the same read-only
COM inspection as removal. State 4 reports running; 1, 2 and 3 report registered but not running.
Only an explicit missing-task answer reports no registration. Unknown state 0, malformed output
and every nonzero PowerShell exit refuse the query. Localized `schtasks` prose is not parsed.

Beyond those native tests these are configuration delivery and focused removal checks, not full
native systemd, launchd, or Task Scheduler lifecycle acceptance. Crash supervision of the fixture
process is proven on systemd and launchd, and absent on Windows: the logon task runs the daemon
directly with no restart, and supervision returns with the job-object work (ruling Q300 A).
Lingering is proven only against mocked and shimmed `loginctl`; no test changes a real user's
lingering. Installer rollback
remains separate audit work. A timed-out manager may already have changed OS state; inspect service
status before retrying. Each file is replaced by a same-directory rename only after a complete
private staging write. A failed write preserves the last complete file. Expiry or a crash can leave
a private `.tmp` sibling; it is never read as configuration and may be removed after installation
has stopped. Replacement of the configuration and unit is not one cross-file transaction.

Launch escaping follows the managers' own rules, not a shell: systemd expands specifiers and
environment references in command lines, launchd takes the program and each argument as separate
XML-escaped strings, and Task Scheduler accepts the program and arguments
through `/tr`. See [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
and [schtasks create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create).
