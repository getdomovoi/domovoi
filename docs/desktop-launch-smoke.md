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
