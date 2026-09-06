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
The report must contain at least six passed native tests and zero skipped,
pending, todo or failed tests. Missing virtualization, a corrupt listing, a
disappearing distro, a failed assertion or a missing report makes the job red.
Success prints `DOMOVOI_WSL_NATIVE_OK`; failure prints
`DOMOVOI_WSL_NATIVE_FAILED` with the underlying reason.

Cleanup runs after success and failure, with its own deadline. It terminates and
unregisters only this invocation's UUID distro and deletes only its staging
directory. Unregistering destroys the disposable guest's files. No existing
distro, runner-wide `wsl --shutdown`, profile or credential is touched. Cleanup
failure is an error too. A cancelled or forcibly terminated hosted job relies
on destruction of the ephemeral runner VM for final cleanup.

## Cost and limits

- Dependency installation: 5-minute step cap, filtered to daemon and protocol.
- Protocol build: 2-minute step cap.
- WSL download, install, configuration and boot: 5-minute total deadline.
- Native proofs: 3-minute total deadline.
- Cleanup: 1-minute total deadline, shared by its commands.
- Entire job: 15-minute hard cap, including checkout and tool setup.

Estimate **3 to 6 minutes for the separate job**, depending on cold dependency
and image downloads. This is a planning estimate, not a measured Domovoi run.
An upstream Ubuntu 24.04 WSL 2 job on our exact image completed installation,
first boot and the running-version assertion in
[45 seconds with a cached image](https://github.com/Vampire/setup-wsl/actions/runs/33942520673/job/101281075218).
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

Once it passes on Windows, the job proves real WSL 2 startup, production
distribution discovery and absent-endpoint handling, missing-distro refusals,
round-tripping a Linux path through the guest's `wslpath`, and refusing Windows
drive paths in both path translation and Git-command preparation with a
non-default automount root. It tests the existing implementation, not a parallel
WSL adapter. Normal unit tests retain their optional native gate outside this
dedicated job.

It does **not** install or authenticate a daemon inside WSL, open a project over
RPC, execute Git repository work inside that daemon, or prove daemon shutdown
and restart. It does not produce or dial a WSL fleet transport, resolve two
distribution identities, or cover Windows 11 mirrored networking and VPNs.
Those are subsequent tests and implementation work. A second distribution is
added only when a test needs two. Merely adding this workflow closes none of
those outcome gaps; the first successful native run is still required evidence.
