# Native WSL CI

The `wsl-native` workflow is a separate Windows 2025 job, not another step in the
normal Windows matrix leg. Pull requests run it only for the WSL implementation,
its open shim, related fleet/transport contracts, dependency inputs and the job
itself. The exact path list lives in `.github/workflows/wsl.yml`. It also runs at
09:23 UTC nightly on the default branch and can be dispatched manually.

Do not configure this path-filtered workflow as an unconditional required check.
GitHub can leave a filtered-out workflow pending. Normal pull requests must not
wait for a WSL job that was intentionally not scheduled. A scheduled WSL job,
however, must fail when its proofs cannot run, never report a green skip.

## Provisioning and failure contract

`node scripts/wsl-ci.mjs` requires a Windows host. It downloads one Ubuntu
24.04.4 amd64 `.wsl` image, streams at most 1 GiB to private staging, and checks
the pinned SHA-256 before installation. The URL and digest came from
[Microsoft's distribution manifest](https://raw.githubusercontent.com/microsoft/WSL/master/distributions/DistributionInfo.json)
on 2026-09-05. Updating either is a reviewed repository change. Downloads share
the setup deadline and have a 30-second network-inactivity bound.

Each invocation creates exactly one `domovoi-ci-<UUID>` distribution. It selects
WSL 2 explicitly, configures the disposable guest to mount Windows drives under
`/domovoi-ci-drives/` instead of `/mnt/`, terminates that distro to apply its
configuration, then executes `uname -r` inside it. A working `wsl.exe` or an
installed WSL 1 distribution is not sufficient. The kernel must identify WSL 2.

The native test process receives the exact required distro name. It must find
that distro running under WSL 2, rather than selecting some other running guest.
The report must contain the ten discovery/transport tests plus five named
repository boundary assertions, all passed, and zero skipped, pending, todo or
failed tests. The guard checks each repository assertion by name and status, not
just a larger total that unrelated tests could satisfy. Missing virtualization, a corrupt listing, a
disappearing distro, a failed assertion or a missing report makes the job red.
Success prints `DOMOVOI_WSL_NATIVE_OK`; failure prints
`DOMOVOI_WSL_NATIVE_FAILED` with the underlying reason. Failed proofs print the
JSON report before cleanup removes it, including when Vitest exits nonzero.
Both console output streams are retained too. Reading failure diagnostics has
its own five-second bound; an unavailable report does not replace the original
failure.

Literal guest commands use `--exec`, not just `--`. The latter ends WSL's option
parsing but still uses the default Linux shell. The first hosted proof exposed
that production path translation let this shell consume UNC backslashes and
expand dollar signs. Path translation, endpoint reads and Git-command
preparation now bypass that shell. The native path proof checks real guest
filenames containing spaces, variable syntax and command-substitution syntax
through both `wsl$` and `wsl.localhost` UNC forms. This does not add a transport
producer by itself.

Before the added transport proofs, the job installs a pinned Linux Node 22.23.2
runtime in that same guest. The checksum is recorded from
[Node's release checksums](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt).
The daemon is built from this checkout. The guest copies its distribution and
integrity-bearing runtime lock, installs with `npm ci --ignore-scripts`, verifies
the graph, grants only node-pty its existing reviewed build permission, and
verifies again. Windows node_modules and a floating registry daemon are never
used. The real built CLI starts through `createProductionDaemon` and publishes
its actual ephemeral loopback port. The test enrolls it through real sockets;
the Windows source's platform keychain is replaced with the existing test store,
not its daemon, protocol, SQLite registry, discovery, heartbeat or socket path.

The Windows fixture holds a foreground `wsl.exe` child attached to the guest
CLI, observes its exit and retains at most 64 KiB of output. Its lifetime is
bounded to three minutes, with a separate 60-second startup deadline. The first
expanded hosted runs exposed a detached `nohup` launch that returned without
publishing an endpoint or any daemon log. Keeping the invocation attached made
startup observable and let all ten proofs run. This is not a proof of detached
shell startup or guest service supervision.

Cleanup runs after success and failure, with its own deadline. It terminates and
unregisters only this invocation's UUID distro and deletes only its staging
directory. Unregistering destroys the disposable guest's files. No existing
distro, runner-wide `wsl --shutdown`, profile or credential is touched. Cleanup
failure is an error too. A cancelled or forcibly terminated hosted job relies
on destruction of the ephemeral runner VM for final cleanup.

## Cost and limits

- Dependency installation: 5-minute step cap, filtered to daemon and protocol.
- Protocol build: 2-minute step cap.
- Daemon build and runtime lock preparation: 5-minute step cap.
- WSL download, install, configuration and boot: 5-minute total deadline.
- Pinned Node download and locked guest dependencies: 5-minute total deadline.
- Native proofs: 4-minute total deadline.
- Failed-proof report diagnostics: a separate 5-second deadline.
- Cleanup: 1-minute total deadline, shared by its commands.
- Entire job: 25-minute hard cap, including checkout and tool setup. The combined
  provisioning/proof command has a 16-minute step cap.

The [first successful Domovoi hosted run](https://github.com/getdomovoi/domovoi/actions/runs/34005827393/job/101412694701)
completed in **1 minute 39 seconds**, with six native proofs passed and zero
skipped: 34.8 seconds provisioning, 2.5 seconds proofs and 0.3 seconds cleanup.
It used WSL 2.7.12.0 on image `win25-vs2026` version `20260824.214.3`, with guest
kernel `6.18.33.2-microsoft-standard-WSL2`. This is an observed run, not a future
duration guarantee. Keep **3 to 6 minutes** as the planning allowance for cold
dependency and image downloads.

The [expanded hosted run](https://github.com/getdomovoi/domovoi/actions/runs/34009889782/job/101423747322)
tested commit `4f3f59c` and completed in **2 minutes 36 seconds**, with ten native
proofs passed and zero skipped. Provisioning took 37.8 seconds, preparing the
guest runtime (Node download/extraction and installing/verifying 115 locked
dependencies) took 17.1 seconds, proofs took 10.8 seconds, and cleanup took 0.8
seconds. It used the same image and WSL/kernel
versions above. This replaces the unmeasured guest-runtime estimate, not the
3-to-6-minute cold-run planning allowance or the hard deadlines. No extra
distribution or normal CI matrix leg is added.

Every Domovoi invocation prints measured provisioning, proof and cleanup seconds
and adds them to the Actions summary after success. Actions records the other
step durations. Unrelated PRs incur no WSL runner minutes.

GitHub's current Windows 2025 image can run WSL 2, but
[nested virtualization is not officially supported or guaranteed](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners).
An image or hardware change that removes it must fail this job. Inspect the
printed image version and WSL error before changing anything. Do not recover by
switching to WSL 1, accepting an empty list or adding a skip. The fallback is a
Windows host whose hardware or parent hypervisor exposes virtualization.

## What the job proves

The successful Windows run proves real WSL 2 startup, production
distribution discovery and absent-endpoint handling, missing-distro refusals,
round-tripping a Linux path through the guest's `wslpath`, and refusing Windows
drive paths in both path translation and Git-command preparation with a
non-default automount root. It tests the existing implementation, not a parallel
WSL adapter. Normal unit tests retain their optional native gate outside this
dedicated job.

The expanded run also proved production WSL route creation after authenticated
heartbeat, a machine-authorized RPC over that route, wrong/root credential
refusal, no route from a stale file after killing the guest daemon, and refusal
of a stopped guest without waking it. These claims come from the required
Windows run, not from Linux's skipped native tests.

The repository extension is registered in the same required guest, before the
deliberate kill and stopped-distro tests. It adds the following real operations:

- Execute the built Windows `domovoid wsl list` and `domovoid open` commands, not
  just their helpers, with both UNC spellings and a repository name containing
  spaces, dollar signs and command-substitution syntax.
- Verify the guest workspace records the Linux path and guest machine id while
  the Windows daemon's project remains unchanged. The Windows CLI deliberately
  receives the Windows daemon's connection configuration, so reusing it for the
  guest would fail the proof.
- Execute the production `distroGitCommand` through real `wsl.exe`, checking
  repository root, commit, clean status, guest filesystem mapping and ownership.
  The guest's Git version is printed. Git comes from the pinned Ubuntu image,
  not a mocked runner or a newly fetched tool.
- Refuse a valid Windows Git repository reached through the custom automount
  root, through both the open shim and Git-command preparation, with the
  Windows-drive remedy and no project mutation on either daemon.
- Refuse direct Windows-daemon `project.open` calls for both WSL share spellings
  with the specific share-boundary refusal, not an unrelated Git failure.
- Stop the real guest daemon gracefully, observe process exit and endpoint
  removal, restart the same profile, and reauthenticate using the stored pairing.
  The persisted project, machine id and Git commit must survive. No assumption
  about a newly chosen ephemeral port being different is needed.

These added assertions require their first hosted run before they count as
native evidence. Linux registration/typecheck and the report-guard unit tests
alone do not prove any Windows crossing.

The job still does **not** resolve two distribution identities or cover
Windows 11 mirrored networking and VPNs. It does not prove the host keychain,
multi-distro port collision handling or an atomic stop-versus-endpoint-read
operation. The regular guest CLI retains WSL's distribution environment; the
saved service launch configuration does not carry those facts today and is not
covered by this proof. The restart is a normal foreground CLI restart, not
crash recovery or supervisor restart. The client open uses the guest's local
root credential; the fleet route separately uses the paired machine credential.
This does not add client admission to a machine credential or prove a session
transfer. A second distribution is added only when a test needs two.

Unit-only cases still include multiple distro arbitration, alternate mount
spellings and manually bound drive paths beyond the configured automount root,
and Git repository-selection argument refusals. Do not infer those outcomes
from the single-guest hosted result.
