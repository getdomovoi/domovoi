# Desktop production launch smoke

Run `pnpm --filter @getdomovoi/desktop test:launch`, or `pnpm test` at the repository root.
This builds and starts the real Electron main process, preload and renderer. Linux uses
`xvfb-run` when available. A display-capable Electron runtime is required; startup failures
fail the test rather than falling back to a mocked daemon.

The smoke uses the normal `DesktopDaemon` acquisition through `acquireLocalDaemon` and
the production factory. It requires an owned daemon, not attachment to another process.
The renderer obtains its endpoint through the normal authorized IPC handler and uses the
shared browser client, under the real document CSP, to:

1. Authenticate with the fresh profile's root bearer.
2. Mint a Desktop-bound client pairing through `device.pair`.
3. Authenticate a second connection with that pairing and read `workspace.get`.
4. Revoke the pairing and verify its authenticated and revoked state through `device.list`.

The main process waits for successful daemon shutdown before emitting
`DOMOVOI_DESKTOP_LAUNCH_SMOKE_OK`. After Electron exits, the runner independently opens
`state.sqlite` read-only and requires the used, revoked pairing. It also requires a cleared
owner record. A renderer that skips RPC and claims success still fails this check.
Failure exits also attempt daemon release, under a separate 10-second cleanup bound. Failure
stays sticky if a success message races it; failed or late cleanup cannot emit success.

## Isolation and bounds

Each run uses a new temporary HOME, USERPROFILE and app-data directories. Inherited
`DOMOVOI_*` settings, Node startup options and the development renderer URL are removed.
Electron's user-data, session-data and log paths are explicitly set before acquisition.
The factory binds `127.0.0.1` on port `0`; IPC returns the actual bound port. The smoke
refuses an existing Domovoi profile. Its temporary profile is removed after the run, including
the test identity, bearer, device registry and workspace store.

The native machine keychain is not isolated by HOME on every host. Fresh-profile startup may
read its index through the normal factory. This smoke does not enroll a machine, write or
remove native machine credentials, contact enrolled peers, or start a provider turn.
Client pairing exercises the SQLite device registry, not OS keychain behavior. Two-host
enrollment, transfer, PTY execution and the full WorkspaceShell are outside this smoke's proof.

The renderer exchange shares a 15-second total deadline, with 5-second connect and request
caps. Production acquisition and release keep their own bounded waits. The runner requests
termination after 60 seconds, or 90 seconds on Windows, covering cold startup through
shutdown. `DOMOVOI_LAUNCH_SMOKE_TIMEOUT_MS` can set a positive integer budget, up to
2147483647 milliseconds. None of these budgets permits a late RPC result to claim success.

# Packaged login service smoke

`pnpm --filter @getdomovoi/desktop package:dir` builds the unpacked app for the host, and
`node apps/desktop/scripts/package-service-smoke.mjs` runs against it. CI runs both at the end
of the `verify` job, so the required `verify (macos-latest)` and `verify (ubuntu-latest)` checks
carry it. The smoke is started with `node`, not `pnpm`: packaging deploys the daemon runtime
with `pnpm deploy --prod`, which leaves the workspace state marked production, and the next
`pnpm` run in that checkout would reinstall `node_modules` for production. The pure parts are
unit tested in `scripts/package-service-smoke.node.mjs`, which runs in the desktop package's
`test` script.

## What it proves

On macOS and Linux, from the unpacked app electron-builder produced on that runner:

1. `domovoid service install`, run from the app's resources under the Node the app ships,
   copies the daemon runtime under a temporary profile (`<profile>/runtime/<version>/`) and
   registers a per-user launchd agent or systemd user unit whose definition runs that copy, not
   the app.
2. `domovoid service status` reads it back installed and running, and the service manager
   itself (`launchctl print` or `systemctl --user show`) reports the job loaded from that
   definition and running.
3. The desktop's attach-only acquisition (`acquireLocalDaemon` from the shipped daemon module)
   reaches the daemon, including its owner proof. An explicit `system.hello` on the endpoint it
   returns answers with the owner record's machine id and the shipped daemon version. The
   profile's owner record names a daemon owner carrying this install's service registration, so
   the daemon that answered is the one the service manager started.
4. `domovoid service remove` exits cleanly. Status then reads not installed and not running,
   the service manager holds neither the definition nor a running job (systemd's load and
   active states are read separately, since a unit can run after its file is gone), the
   definition and `service.json` are gone, and the attach-only acquisition is refused.

On Windows the step runs the same script, which prints why it skips and installs nothing. Logon
task supervision is still changing there, so the Windows leg proves nothing about the Windows
service.

## What it does not prove

- The Settings Install and Remove flow in the running app (`DesktopDaemonService`): the turn
  refusal, the handoff fence, stopping the app's own daemon and attaching from Electron's main
  process. The smoke runs the same daemon installer and attach code, outside Electron.
- Signed, notarized or installer artifacts (DMG, ZIP, AppImage, deb, NSIS), App Translocation,
  a disk image, an app moved after install, or an update in place.
- Start at login or boot, or after the last session ends. CI turns lingering on before the
  smoke and nothing reboots. Crash restart is covered by the daemon's native service tests.
- Provider turns, PTYs, pairing or anything past `system.hello`.

## Isolation

The smoke changes the service manager of the account that runs it, and a temporary HOME does
not contain that. launchd binds the fixed label `sh.domovoi.domovoid` in the account's one
`gui/<uid>` domain, whichever plist it came from. The installer takes its service-operation
lease under the account's own home as the password database names it, not `HOME`. On Linux the
systemd user manager reads units only under the home it started with.

So the script refuses, before it changes anything, unless `CI=true` and
`DOMOVOI_SERVICE_SMOKE_DISPOSABLE_HOST=1` are set, the account's `~/.domovoi` is absent or
holds nothing but that lease file, and no Domovoi service is loaded for it. Any service
command the account runs leaves the lease file behind, and it holds no profile state, so it
alone does not refuse. Do not run it on a developer machine. On macOS CI it uses a
temporary HOME and profile, and the lease file stays in the runner account's `~/.domovoi`. On
Linux CI it runs only as the throwaway `domovoi-smoke` account, which the workflow creates with
its own lingering systemd manager, from a copy of the unpacked app that account owns. Fresh
daemon startup may read the native keychain index, as in the launch smoke.

Each command has its own bound: 180 seconds for install, 120 for removal, 30 for status and
manager reads. The attach is retried for up to 90 seconds after install. After removal, the
manager and the attach are read for up to 30 seconds until the manager holds neither the
definition nor a running job and the attach is refused. These windows are checked between
attempts, not imposed on them, so each can run over by one attempt. An attach attempt is
bounded at 20 seconds and a manager read at 30, each with up to 2 more seconds to stop a
process that ran over, and attempts are one second apart. The step's own CI timeout bounds the
whole run. If a run fails after install, it
removes the service. Once anything was installed, the work directory with the runtime copy
and profile is deleted only when the manager confirms the service gone; otherwise it is kept
and named.
