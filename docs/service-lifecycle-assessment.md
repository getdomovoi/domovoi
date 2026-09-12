# S1.1 service lifecycle assessment

Status: fetzy selected option A for Windows user logon on 2026-09-11, with
option D's explicit lack of Windows boot supervision. The task compiler and
native fixture exist; installer integration and supervision acceptance remain open.
Measured on 2026-09-11 after fetching `origin/main` at
`98c412c540bad49b9cbf2459a47bc3309cda62b8`. S1.1 remains open; this document
does not claim completed lifecycle acceptance.

The accepted scope is Unix acceptance, two status-reporting fixes, and Windows
and WSL lifecycle decisions. Existing Unix adapters already install, supervise
and remove services. Calling those adapters missing would duplicate work.
The separate `apps/cli` work belongs to S1.6; this assessment covers the daemon's
existing lifecycle handlers and supervisor entry point.

## WSL decision

Domovoi will own a Windows task that starts the selected WSL distribution and
foreground daemon at that distribution owner's Windows logon. Windows boot
supervision is unavailable. Starting the distro by other means is a separate
event and does not trigger the Windows task.

Fetzy's governing principle is that a supervisor may own its own artefacts and
may not own the host's. Options B and C edit configuration belonging to the
distro. A creates Domovoi's own task, the only proposed supervisor registration
that can be removed wholly as Domovoi's artefact. Its removal is therefore a
proof obligation the implementation can own; the guest-stop proof is still due.
A systemd unit's five-second crash policy does not solve the lifetime of the
distro containing it. The policy can be real while WSL terminates its supervisor.

Windows boot is a category error for the supported per-user contract: the
daemon needs the distribution owner's keychain and repositories, and SYSTEM
does not acquire that user's distribution by running a task. Fetzy rejected
storing account credentials to establish that context before logon. There is
no boot trigger in this design and no attempt to change the distro's init or
boot configuration to supply one. Task Scheduler also offers passwordless
[S4U logon](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype),
with network/encrypted-file restrictions; it has no acceptance proof for this
WSL/keychain/repository contract and remains outside support.

Acceptance must separately observe guest death, the Windows action's result,
and an automatic restart. A nonzero result alone does not establish supervision.
The fixture sends SIGKILL to its identified guest daemon, expects action result
9 on WSL 2.7.13, then requires a new identified guest without another manual
task start. Guest death reaching Windows is proved below; automatic restart
remains unproved. The service path filter landed in [#368](https://github.com/getdomovoi/domovoi/pull/368),
and the fixture now runs in its own WSL CI phase. Removal must independently
prove the exact guest daemon stopped, as described below. Native Windows
supervision remains a separate decision.

### Native observation, 2026-09-12 UTC

[WSL run 34673797459](https://github.com/getdomovoi/domovoi/actions/runs/34673797459/job/103499922442)
at `55566371dd584d9b6351f67557b9837b12828747` made 447 completed task queries.
The first returned State 4 and LastTaskResult 267009; the following 446 returned
State 3 and result 127. Every query retained LastRunTime
`2026-09-12T04:47:25.0000000Z`, through 224.349 seconds after the start request.
The fresh failure snapshot still showed that timestamp and all guest sidecars
missing. Task history was disabled, so it supplied no event evidence.

The configured one-minute, three-retry policy did not retry this 127 outcome
within that observation window on this runner. This does not establish behavior
for every nonzero exit, or for SIGKILL. Neither automatic
restart nor the complete removal proof has passed acceptance yet.

The ordinary-argv control ran as root with the expected Node executable and
accessible guest files. The registered action quoted every WSL prefix token.
WSL 2.7.13 [reads those tokens raw](https://github.com/microsoft/WSL/blob/80697fd42cca3de0c0d5dd1931c36112372a577e/src/windows/common/helpers.cpp#L576)
and [parses the exec tail with CommandLineToArgvW only after recognizing `--exec`](https://github.com/microsoft/WSL/blob/80697fd42cca3de0c0d5dd1931c36112372a577e/src/windows/common/WslClient.cpp#L1799).
The compiler therefore leaves the prefix bare, refuses whitespace or double
quotes in distribution/user tokens, and quotes only the exec tail. Names that
cannot be represented by this prefix parser are explicitly unsupported here.

The quoting controls did not execute in that run: their generated Node script
contained newlines rejected by the task validator. The shared probe builder now
uses a single-line script and is exercised by portable validation and execution
tests. Native controls retain the old quoted prefix as a negative observation;
their host context does not establish Task Scheduler context. Per-poll run times
remain in place to observe the next failure and retry result.

[WSL run 34675277932](https://github.com/getdomovoi/domovoi/actions/runs/34675277932/job/103503921460)
at `0b5407f59244a16fc56bc2d67eee59a55449ca33` reached its identified, live guest
at 9.843 seconds of lifecycle time. SIGKILL stopped that guest and the ready
Windows task reported LastTaskResult 9. The fixture incorrectly expected 137
and stopped before restart polling. WSL 2.7.13's
[init exit reporting](https://github.com/microsoft/WSL/blob/80697fd42cca3de0c0d5dd1931c36112372a577e/src/linux/init/init.cpp#L2043)
applies WEXITSTATUS only to normal exits; signal death retains the raw waitpid
status. For SIGKILL that status is 9, matching the measured Windows result.
The assertion now pins 9. Whether this result triggers the configured PT1M
retry and whether the full removal proof passes remain open.

All three invoking-host quoting controls executed in this run. The bare-prefix
control returned 0 with literal guest arguments intact. Quoting every prefix
token returned 127 with `--distribution: command not found`; quoting just the
prefix values returned 4294967295 with WSL_E_DISTRO_NOT_FOUND. These controls
explain the earlier launch failure; the task's own live guest separately proves
that the corrected action launches in Task Scheduler context.

## Measured platform gaps

Source locations in this section refer to the baseline commit above.

| Platform | Built | Evidence read | Remaining work or decision |
| --- | --- | --- | --- |
| macOS | Per-user LaunchAgent in `gui/<uid>`, saved configuration, install/remove, `RunAtLoad`, and `KeepAlive` with `SuccessfulExit=false`. `service/install.ts:182`, `service/units.ts:69`. | Native lifecycle and crash/clean-exit tests at `service/launchd-agent.native.test.ts:322` and `:376`; [macOS job](https://github.com/getdomovoi/domovoi/actions/runs/34635457431/job/103382119331) ran that file's nine tests with no skips. | Fix `service/install.ts:444`: loadedness is reported as running. Acceptance still needs the intended login/logout and reboot boundary. The existing GUI agent supplies no pre-login daemon contract. |
| Linux | Per-user systemd unit, `enable --now`, status, `disable --now` and removal, `Restart=on-failure`, five-second restart delay. `service/install.ts:169`, `service/units.ts:48`. | [Linux job](https://github.com/getdomovoi/domovoi/actions/runs/34635457431/job/103382119025) ran both tests in `service/systemd-unit.native.test.ts`: lifecycle plus crash restart, explicit-stop and clean-exit negatives. | The installer does not enable lingering. Decide the required login/logout and boot behavior before adding it. Native proofs use a throwaway process and unit; they do not reboot the host or prove production-daemon state recovery. |
| Windows | Limited-user `ONLOGON` Task Scheduler task, immediate demand start, saved configuration, bounded disable/stop/observe/delete removal. `service/install.ts:193`, `service/windows-task.ts:66`. | [Windows job](https://github.com/getdomovoi/domovoi/actions/runs/34635457431/job/103382119358) ran `service/windows-task.native.test.ts:23`: one native stop-before-delete proof. Portable tests and the intercepted-manager CLI test cover creation/configuration. | The implementation is a user task, not an SCM Windows service. Crash restart is not configured. Full native creation/logon acceptance is missing. Fix the English `Status: Running` match at `service/install.ts:466`; formatting localized values as CSV would not establish a stable state contract. |
| WSL without systemd | The daemon runs in a real guest and exposes authenticated transport. `index.ts:169` passes `process.platform`, so service installation takes the ordinary Linux `systemctl --user` path. There is no WSL-specific supervisor selection. | [Native WSL run](https://github.com/getdomovoi/domovoi/actions/runs/34633804887/job/103376745829) at ancestor `9a3af4976f0e3c31a8c94aaa2f824ebe4a13a90a`: WSL 2.7.13.0, 15 passed, zero skipped. | Select the launch trigger, crash supervisor and instance-lifetime contract. The proof has `systemd=false`, an explicit foreground launch and an explicit restart. It does not install or test automatic supervision. |

The three ordinary CI jobs above ran against the exact measured main commit.
Their logs distinguish native tests from platform skips. The ordinary Windows
suite skipped 11 of 15 WSL tests; the separate native job is the evidence for
those guest proofs, not the Windows check row.

`docs/daemon-services.md` said both macOS native tests were unexecuted and
repeated that claim in its remaining-limits paragraph. The logs disprove it.
This understated capability and invited duplicated work. It is the inverse of
an overstated claim creating false confidence, not merely a wording error.

Shared machinery already supplies private saved configuration, operation and
profile leases, bounded manager calls, stop-before-delete, and registration-bound
removal receipts. Installation is not a transaction across native manager state
and files. A timed-out manager can finish late; the existing documentation names
that reconciliation limit. Turn/worktree/transfer recovery belongs to S1.3.

## WSL options

These are the assessed alternatives; the decision above selects A for logon
and rejects boot supervision. The assessment distinguished **Windows boot**,
**Windows user logon**, and **WSL
distribution startup**. A process supervisor and an event that launches that
supervisor are separate mechanisms; some requirements would need a combination.

WSL still has its own init when systemd is disabled. The missing piece is a
service supervisor for Domovoi. Microsoft's [systemd documentation](https://learn.microsoft.com/en-us/windows/wsl/systemd)
also states that systemd services alone do not keep a WSL instance alive.
The [WSL lifetime description](https://learn.microsoft.com/en-us/windows/wsl/faq#can-i-use-wsl-for-production-scenarios)
is another reason to test instance lifetime separately from process restart.

| Option | Restart after daemon crash | Windows boot | Windows user logon | Distribution startup | Removal obligation |
| --- | --- | --- | --- | --- | --- |
| A. Windows task runs `wsl.exe -d <distro> --exec domovoid` in the foreground | Possible with an explicit task restart policy and verified propagation of guest failure to the Windows action. Neither is currently proved. | Possible with a boot trigger and a suitable principal; not supplied by the current logon trigger. | A logon trigger can launch it using the distribution owner's Windows identity. | The task's explicit launch can start the selected distro. Starting it elsewhere does not itself trigger this task. | Disable triggers/restarts, stop and observe the Windows task, independently prove the exact guest daemon stopped, then remove only the matching registration/configuration. |
| B. Enable `systemd=true`, use the existing user unit | Existing `Restart=on-failure` policy is reusable while the guest and user manager remain alive. WSL execution of that unit still needs a native proof. | No Windows launch trigger supplied. | Logging on to Windows alone supplies no trigger. | Enabled unit starts when its user manager starts; user-session readiness or lingering must be established. | Use the Linux stop/disable/removal path in the guest. Preserve distro-wide systemd and any pre-existing lingering settings. |
| C. A `wsl.conf` boot command launches Domovoi | A boot command alone supplies no retry policy. A restart loop would introduce another supervisor to implement and remove. | No Windows launch trigger supplied. | No Windows logon trigger supplied. | Hook runs when the distro starts, under root. An owned launcher must select the intended Linux user/profile and allow distro startup to complete. | Remove only the owned hook, stop the exact process or helper, and verify it cannot relaunch. Preserve other `wsl.conf` settings and any existing command. |
| D. No managed WSL lifecycle; document foreground operation | No automatic restart supplied by Domovoi. | No trigger. | No trigger. | No trigger; operator explicitly launches the daemon. | Stop the owned foreground invocation. An unknown custom supervisor requires operator confirmation; absence of a task/file is not stop proof. |

**A. Windows Task Scheduler.** This can preserve `systemd=false` and make the
Windows task own the foreground invocation. An installed command must name the
distribution, Linux user, absolute runtime/entry point and saved guest
configuration; it must not rely on shell startup files or move guest credentials
to a Windows profile. WSL distributions are [installed per Windows user](https://learn.microsoft.com/en-us/windows/wsl/setup/environment#set-up-your-linux-username-and-password),
so a LocalSystem task is not an equivalent launch identity.

Microsoft requires administrator membership to [create a boot-trigger task](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger).
An interactive-token task requires a logged-on user. A password logon and S4U
have different credential and network/encrypted-file implications, documented in
[Principal.LogonType](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype).
Actual WSL startup under the chosen noninteractive identity would need proving.
Supporting pre-login boot therefore changes the privilege/identity contract.

Task Scheduler exposes [restart count](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-restartcount)
and [restart interval](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-restartinterval);
the documented minimum interval is one minute, unlike the existing systemd unit's
five seconds. Specify retry exhaustion, clean exit and deliberate stop behavior.
Also specify and read back runtime, battery and multiple-instance settings.
The documented [execution limit](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit)
defaults to 72 hours and allows an explicit unlimited value. This is a documented
default, not a measurement of the current `schtasks` installation.

The principal cost is ownership across Windows and Linux. Terminating `wsl.exe`
or observing a stopped Windows task has not been proved to terminate the guest
daemon. A task failure during removal must not silently erase guest launch input.

**B. systemd.** This reuses the most established adapter. Microsoft documents
WSL 0.67.6 or newer, editing `/etc/wsl.conf`, restarting the distribution, and
ensuring the required systemd packages are installed. It changes the whole
distribution's init hierarchy, not just Domovoi. See [enabling systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd#how-to-enable-systemd).
For the existing user unit, also establish the intended user's manager and bus.
[Lingering](https://www.freedesktop.org/software/systemd/man/252/loginctl.html)
can start that manager at guest boot and retain it after logout; it is a separate
user-manager policy change, not implicit in `systemd=true`.

Applying the change interrupts the distribution's other processes. A targeted
`wsl.exe --terminate <distro>` affects that entire distro; `--shutdown` affects
all running distributions. [Configuration restart semantics](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#the-8-second-rule-for-configuration-changes)
make that interruption part of the choice. Removing Domovoi must not disable
systemd or lingering that other services may now rely on. This option still needs
an independently specified Windows launch/lifetime mechanism if unattended
availability is required while no user has opened the distro.

**C. `wsl.conf` boot command.** Microsoft documents this hook for Windows 11 and
Server 2022; it executes as root when the instance starts. See [boot settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#boot-settings).
It offers an init-independent launch point, but would require privileged edits
to a shared configuration file, preservation of any existing hook, an explicit
Linux identity and a safe startup/stop contract. A backgrounded process or helper
would still need lifetime and removal proofs. Nothing in that launch hook alone
provides restart after a crash. Adding a supervisor loop would materially expand
this option beyond one configuration line.

Changing or removing the hook takes effect on a later distro start. Removal must
therefore handle the currently running invocation separately. It must neither
overwrite someone else's boot command nor use distro termination as routine
service removal.

**D. Document the limit.** This preserves the distro and current manual lifecycle.
It accepts that a crash leaves the daemon down until an operator starts it.
It cannot satisfy a requirement for automatic restart or unattended availability.
Installation/status must explicitly report unsupported supervision when the
required manager is unavailable, rather than leaving a failed install looking
registered. The existing foreground proof is useful evidence for this limited
contract, but it is not a long-term availability test.

## What existing proofs can carry forward

| Existing mechanism | Already establishes | Does not establish for a new WSL option |
| --- | --- | --- |
| `service/removal-recovery.ts:59` and its 19-test suite | Refuses changed owner/configuration; receipt requires matching registration, the same owner and a confirmed manager stop. `install.ts:378` checks under the acquired profile lease. | Which Windows action owns which guest process, whether a boot hook has been disabled, or whether an external supervisor can restart it. The Boolean manager-stop input needs new evidence. |
| `service/removal-recovery.ts:78` | Receipt manager is selected from the local platform: Linux/systemd, macOS/launchd, Windows/task-scheduler. | Windows-supervised Linux has no unchanged adapter here. Labeling the stop as systemd merely because the guest platform is Linux would be false. |
| Native Windows removal test | A disabled/stopped task no longer owns its tested Windows Node process before deletion. | Exit of a Linux process behind `wsl.exe`, guest profile-lease release, crash retries or Windows logon/boot triggers. |
| Native Linux service tests | Real systemd unit lifecycle, crash restart, explicit stop and clean-exit behavior with a throwaway process. | The same unit running under WSL's systemd/user-session setup, distro lifetime or Windows boot. |
| `scripts/wsl-ci.mjs:116` and `wsl-ci-guest.mjs:12` | UUID-named disposable WSL 2 guest, `systemd=false`, locked production daemon runtime, required named proofs with no skips, bounded cleanup. | A user service installation or any of the four startup policies. The finite `sleep 600` at `wsl-ci.mjs:167` deliberately keeps the fixture guest available. |
| `wsl-native-transport-proof.ts:59`, `:165`, `:188`, `:202` | Foreground production daemon, graceful exit and explicit restart, stale-endpoint refusal after killing the daemon, and refusal to wake a deliberately stopped guest. | Automatic crash restart, a Task Scheduler registration or boot hook, non-root/noninteractive identity, reboot/logon behavior or idle survival without the fixture keeper. |

The disposable distro and required-report checker are reusable test foundations.
`wsl-ci.mjs:78` requires each named proof exactly once; additions must update that
list explicitly. A separate systemd-enabled variant would be required for B,
while retaining the current systemd-disabled transport proof. If a lifecycle
change should run WSL CI, the path filter in `.github/workflows/wsl.yml` must cover
its files. At the original baseline it omitted `apps/daemon/src/service/**`;
[#368](https://github.com/getdomovoi/domovoi/pull/368) closed that gap. The service
fixture runs separately from the transport proofs, with its own report and budget.

Any selected managed option needs failure injection at every new shell-out:
enumerate documented answer codes, refuse all other codes, preserve primary and
cleanup failures, and prove no later deletion starts after an unknown stop or
expired deadline. Also prove that deliberate removal cannot trigger a retry,
that an unrelated distro/task/hook is untouched, and that guest profile data is
preserved. These are required follow-up proofs, not tests already run.

The selected contract is Windows user logon, with a Domovoi-owned task and no
distro-wide init changes. Supported versions, retry limits, idle lifetime and
the exact Windows/Linux identity binding still need implementation evidence.
The task fixture has exercised registration and an unsuccessful action launch
in a disposable guest. It has not established managed WSL supervision.
