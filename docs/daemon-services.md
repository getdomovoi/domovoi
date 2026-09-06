# Daemon service configuration

`domovoid service install` installs a per-user systemd unit, launchd agent, or Windows logon task.
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
user home used for durable state. Relative input paths become absolute against the installing
shell's working directory. The default paths and port are captured too, so a changed environment
cannot silently choose a different identity or endpoint after a restart.

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

## Windows removal

`domovoid service remove` disables the logon task before stopping it, waits for Task Scheduler to
report that it is disabled with no queued or running instances, and only then removes the task and
saved configuration. Deleting a registration alone does not stop its running program.
See [schtasks delete](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-delete)
and [RegisteredTask.State](https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-state).

The Windows path uses the built-in Windows PowerShell Task Scheduler COM interface, not localized
`schtasks /query` text. The executable is resolved beneath the absolute local `SystemRoot`, never
from the project directory or `PATH`; a missing or relative OS directory refuses before spawning.
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
and an absent saved configuration. It runs `systemctl` only in the user scope, refuses a command
naming any other unit, refuses to overwrite a name that already exists, and cleans up whatever the
assertions did. That cleanup also resets the unit's failed state, because a run that ends in
failure stays loaded and listed as failed after its fragment file is deleted, and it then requires
the manager to list nothing failed under that name. Its gate is the systemd user manager's private socket, so a machine without a
running user manager skips it. The Linux CI leg starts that manager and fails when the socket is
missing, so the test cannot disappear from the run.

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
`systemctl` chokepoint, the refusing preflight and the always-run cleanup with the lifecycle test
rather than carrying a second copy of them.

A native macOS-only test drives launchd itself through the same install, status and removal
functions the CLI calls. It bootstraps a throwaway agent into the per-user `gui/<uid>` domain the
installer targets, checks that the domain registered that exact file as a launch agent, that it is
running, and that the process launchd reports is the one that wrote its own PID file, then removes
it and requires process exit, an absent agent, an absent saved configuration and a domain that no
longer answers for the label. Its label is the production one with a fresh identifier appended, so
it cannot collide with the operator's own agent while still being classified by the daemon's own
missing-service matcher. Bootstrapping names a path rather than a search directory, so every file
stays inside a throwaway home and nothing is written to the operator's own `Library/LaunchAgents`.
It runs `launchctl` only, refuses any domain but this user's own, refuses to name the production
label, refuses to overwrite a label that already exists, and cleans up whatever the assertions did.
Its gate is that domain, so a session without one, such as a plain ssh login, skips. The macOS CI
leg asserts the same domain and refuses to run as uid 0, so the test cannot disappear from the run
and cannot pass against `gui/0` instead.

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

Both macOS tests are unexecuted. They were written on Linux, which cannot run launchd, so their
first run on a real macOS runner is the evidence for every assertion in them. What is settled now
is the runner question they depend on and the three facts the supervision test is sized against,
all read off real hosted macOS jobs rather than assumed. A hosted GitHub macOS runner does run
inside a GUI login session: `actions/runner-images` provisions every macOS image with GUI
auto-login for the runner user, and a green `macos-14` job has published a `launchctl print` dump
showing `domain = gui/501` with a live audit session id, `type = LaunchAgent`, `state = running`
and a real `pid`. That is an agent which runs, not one which only loads. The relaunch witness is
`runs`, launchd's own spawn counter, which belongs to a single bootstrap and is therefore only read
as a delta across a crash. The relaunch delay is launchd's own throttle, reported as
`minimum runtime` and defaulting to ten seconds, which is what the no-relaunch window is sized
past. What remains unobserved in any public run is the exact composition these tests perform, a
`SIGKILL` through the manager followed by a `KeepAlive` relaunch in the per-user domain, so that is
what their first run settles.

macOS status reports loadedness, not liveness. `domovoid service status` runs
`launchctl print gui/<uid>/<label>` and reads its exit code, so an agent whose process has exited
and will not be relaunched still reports as running. The lifecycle test asserts that exact wording
rather than treating it as a liveness check.

Beyond those native tests these are configuration delivery and focused removal checks, not full
native systemd, launchd, or Task Scheduler lifecycle acceptance. Crash supervision is proven on
systemd, written but not yet run on launchd, and absent on Windows: the logon task is created with
no restart setting at all, so nothing on that platform claims to relaunch a crashed daemon before
the next logon and there is no policy there for a test to hold to. Installer rollback
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
