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

HOME does not move everything. The login-service calls (status, install, update, remove)
take the service-operation lease at `.domovoi/service-operation-lease.sqlite` under the
account's passwd home, on purpose, so a changed HOME cannot split that lock. The fleet client
proof runs the full WorkspaceShell, whose Settings reads the service status on mount, and that
read used to write the real `~/.domovoi`. Both smokes that start the app now pass the
test-only `--domovoi-test-no-login-service` switch. An unpackaged app given it makes no
login-service call: status reads as unavailable and a service change stops at its first check.
The switch is read from the command line only, never the environment, and a packaged app
ignores it, so `test:package` does not use it. The login service itself is not part of these
smokes' proof.

Each of those runners also snapshots the real profile before it starts and compares after its
children exit: whether `~/.domovoi` exists, and the mode, inode, size, modification and change
time of the lease and its SQLite `-journal`, `-wal` and `-shm` files. A difference fails the
run and names the paths. The check only reads; a missing profile is never created. It does not
watch the rest of the profile, which a Domovoi running on the same machine writes in normal use.

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
