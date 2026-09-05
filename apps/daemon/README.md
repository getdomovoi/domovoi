# @getdomovoi/daemon

Execution daemon for Domovoi agent sessions. It owns repository state, terminals, approvals,
artifacts, and the authenticated JSON-RPC endpoint beside the code.

## Workspace use

`@getdomovoi/daemon` is not currently published to a package registry. Until the first release,
use it from this repository's pnpm workspace:

```bash
pnpm install
pnpm --filter @getdomovoi/daemon build
```

The package is standard ESM. After publication, the supported frozen installation is the
verified bootstrap described in [the distribution contract](https://github.com/getdomovoi/domovoi/blob/main/docs/distribution.md).
It requires Node 22 with bundled npm 10.0.0 or newer and installs the archive's integrity-locked
runtime before publishing its receipt. Manual npm, pnpm, or Bun adds of the daemon are not frozen.
Native compilation and the external toolchain remain reproducibility limits; provider SDKs are
downloaded under their existing terms, not bundled in this package.

## Run

```bash
pnpm --filter @getdomovoi/daemon start
```

The daemon listens on `127.0.0.1:47831` by default. Configure it with these environment variables:

| Variable | Purpose |
| --- | --- |
| `DOMOVOI_HOST` | Listener host |
| `DOMOVOI_PORT` | Listener port |
| `DOMOVOI_AUTH_TOKEN` | Bearer token required by RPC requests |
| `DOMOVOI_CREDENTIAL_PATH` | Generated daemon credential file path |
| `DOMOVOI_MACHINE_IDENTITY_PATH` | Stable machine identity file path |
| `DOMOVOI_TLS_CERT_PATH` | TLS certificate chain, required for a non-loopback listener |
| `DOMOVOI_TLS_KEY_PATH` | TLS private key, required for a non-loopback listener |
| `DOMOVOI_ADVERTISE_HOST` | Name an encrypted listener is advertised as reachable by |
| `DOMOVOI_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to connect |
| `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1` | Explicitly permits a non-loopback listener |

Every daemon requires authentication. When `DOMOVOI_AUTH_TOKEN` is unset, `domovoid` creates and
reuses a high-entropy credential at `~/.domovoi/daemon.token`. On POSIX, private state files are
`0600` inside a `0700` state directory and permissive files are repaired on startup. On Windows,
state lives under `.domovoi` in the user profile directory and no additional ACL restriction is
applied yet. Remote
listeners also require `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1` plus `DOMOVOI_TLS_CERT_PATH` and
`DOMOVOI_TLS_KEY_PATH`, which must be set together. The daemon terminates TLS itself and refuses
to start a plaintext non-loopback listener.

The bearer token protects RPC access. Health checks remain public. Preview documents require their
own short-lived signed capabilities on every listener, loopback included; each capability is scoped
to one artifact revision, purpose, annotation bridge channel, and parent origin, and an unsigned or
retargeted request returns 404.

## Fleet enrollment and recovery

`fleet.enroll` is a local-root operation. It claims a versioned pairing code, authenticates as
this machine, and reads the target's own descriptor on one connection. The source records the
endpoint it actually authenticated over separately from the target's advertisements. Remote
listeners require TLS; relay enrollment and plaintext off-machine endpoints are refused.

Peer credentials stay in the OS keychain, never the renderer or the workspace snapshot. SQLite
journals retain an operation kind and credential digest, not its bytes. Enrollment is published
only after matching keychain readback. Pending enrollment/forget operations remain visible and
resume on startup. Heartbeats refresh target facts every 15 seconds, with each attempt bounded
by a 30-second operation deadline. A failed attempt does not advance the last-contact timestamp.
Forget reports whether the target confirmed revocation; unconfirmed removal requires revoking
this machine in the target's Devices list. Enrollment does not grant a client credential for
remote Use or Terminal; that is a separate admission step.

Admission is limited to 128 machine entries, including the local machine and pending enrollment
reservations. At capacity, re-pairing an existing row requires its `expectedMachineId`; an unnamed
target is refused before consuming the pairing code. Recovery rows remain visible beyond the
admission limit. The wire list is bounded at 512
total entries. Older keychain indexes had no count limit. An over-cap index therefore refuses the
entire list with `fleetSnapshotOverflowErrorCode` (`-32016`) and a `fleet-overflow` error payload
containing `limit`, `totalEntries`, and `entriesNotShown`. No rows are silently truncated.

For exceptional over-cap recovery, run these locally as the same OS user who runs Domovoi:

```bash
domovoid fleet-keychain list
domovoid fleet-keychain forget <machine-id> --confirm-daemon-stopped
```

Stop Domovoi and its supervisor before `forget`. The confirmation asserts that you have stopped
them; the command does not stop or independently verify them. Otherwise a running reconciliation
could race the repair. `list` prints the complete indexed machine IDs, never credential bytes,
without the wire cap. `forget` removes only the named local key and index entry, checks readback,
and leaves unrelated credentials and fleet facts intact. It does not prove revocation on the
target: revoke this machine in the target's Devices list as well. Restart Domovoi and use ordinary
Fleet Forget for remaining recorded facts once the list fits. These commands require the OS
keychain to be available. Pagination of larger legacy fleets is not implemented.

## Pairing admission and audit retention

Pairing claims are limited to three per source address and thirty across the listener in a rolling
minute. For a valid JSON-RPC request naming `device.claim`, admission runs before parameter
validation, protocol compatibility or code verification, so malformed parameters and incompatible
versions count and a throttled valid code is not consumed. Admitted
version mismatches return the update-required error without spending a code guess; exhausted
sources receive the ordinary pairing refusal regardless of the submitted version or shape.
The source is the TCP peer address, not a forwarding
header. Reconnecting, greeting with a credential, or issuing another code does not reset these
budgets. Peers behind the same NAT or proxy share the source budget. A throttled claim receives the
ordinary pairing refusal and its socket closes with code `1008`, reason `pairing rate limit`.
Wait a minute before trying again; an expired code needs replacing after the cooldown.

The five-wrong-guesses limit and three-minute code lifetime still apply. Admission limits reduce
abuse; they do not guarantee pairing availability against distributed peers or a peer that keeps
trying after cooldown. Keep code-based pairing on a protected direct route. Limits are held for
the lifetime of the daemon; a restart also invalidates its open pairing code.

The audit retains up to 10,000 activity entries and a separate maximum of 1,000 pre-authentication
entries. Rejected claims, authentication failures, and invalid requests cannot spend activity
retention. Repeated ingress events record only the first event of each category per minute, not a
complete attempt count. Successful pairings remain activity records. Both classes remain available
through audit query and export, without recording submitted codes, credentials, or claimant labels.
Upgrades preserve existing history without guessing which older rows were unauthenticated; the
retention distinction applies to new writes.

## Transfer chunk retries

Concurrent receives for the same transfer member use a process-local reservation keyed by the
journal path. It covers chunk reads and writes, final publication, and chunk-directory cleanup.
A competing receive gets the existing `chunk-out-of-order` refusal without waiting; a retry after
the owner finishes can adopt its durable chunk or completed member. Other members can progress
independently. This prevents cleanup racing a retry's open chunk handle within one daemon process,
which Windows can reject with `EPERM`. It does not coordinate separate daemon processes sharing a
journal directory.

Production transfer RPCs share a per-transfer resource queue across sockets. A reconnected retry
or abort waits for the original handler to finish; dropping its socket does not release that
queue slot. The journal's overlap refusal protects concurrent direct journal calls, not the
ordinary reconnect path. Retention pruning runs before the daemon opens its listener.

## When state cannot reach disk

The daemon writes the workspace snapshot after every change. A single failed write is retried on
the next change. After three consecutive failures the daemon declares persistence unavailable and
refuses mutating RPC methods with `daemonPersistenceUnavailableErrorCode` (`-32014`) instead of
running on state nobody will get back. Every failure is still reported through the daemon error
sink, and `system.emergencyStop` still reports a `persistence` failure in its bounded outcome.

Read-only methods keep working, including `workspace.get`, so an operator can read the state that
is not reaching disk. `system.pauseAll`, `session.pause`, and `system.emergencyStop` also keep
working, because they reduce what an unpersisted daemon is still doing. The daemon accepts changes
again as soon as one write succeeds, since each write stores the whole snapshot.

## Supervise

Install the daemon as a service for the user who asks for it:

```bash
domovoid service install
domovoid service status
domovoid service remove
```

`install` writes a systemd user unit on Linux, a launch agent in the user's own `LaunchAgents` on
macOS, and a logon task on Windows, then asks the platform's service manager to load it. Nothing is
written to a system-wide location and no step asks for elevation. `status` reports whether the
service file is present and whether the manager currently runs it, and exits non-zero when nothing
is installed. `remove` stops the service and deletes the file it pointed at.

A service file never carries a secret. `DOMOVOI_AUTH_TOKEN` and any other credential stay in the
user-private files the daemon already reads.

## Programmatic use

`@getdomovoi/daemon` exposes one supported production factory. It owns the daemon credential,
stable machine identity, provider discovery, peer-credential store, TLS loading, state database,
and worktree root. Embedders cannot omit those production dependencies or replace them with test
seams.

```ts
import { createProductionDaemon } from "@getdomovoi/daemon"

const daemon = await createProductionDaemon({
  errorSink: ({ context, detail }) => console.error(context, detail),
})

const endpoint = await daemon.start()
console.log(endpoint.url)

await daemon.stop()
```

`ProductionDaemonOptions` accepts:

| Option | Purpose |
| --- | --- |
| `environment` | Daemon environment; defaults to `process.env` |
| `homeDirectory` | State-directory base; defaults to the current user's home |
| `machineLabel` | Initial label for a new machine identity; defaults to the hostname |
| `errorSink` | Receives daemon failures as `{ context, detail }` |

The returned handle exposes the configured `host`, `requestedPort`, whether the transport is
secure, where its credential came from, and `start()` and `stop()`. `start()` returns the actual
host, port, and WebSocket URL. The handle also carries `authToken` for an embedding client; treat
it as a root credential and never log it or persist another copy.

The package retains `@getdomovoi/daemon/internal` as an inert artifact-compatibility entry point.
It does not expose the raw server constructor or a supported runtime API. Daemon tests import the
source server module directly.

## Bundle restore claims

Only one bundle restore may mutate a session worktree at a time. A process-local reservation is
taken before asynchronous work, and an exclusive file at
`<worktree-root>/.restore-claims/<session-id>` also excludes other daemon processes. Contention
fails immediately, without waiting or retrying. Restoring a different session remains independent;
a later incremental restore is still allowed after the earlier operation settles.

Each claim records a fresh ownership token before repository work starts. Once acquired, token
initialization finishes under its own I/O deadline even if the restore is cancelled, so cleanup
can still identify and remove the claim. Success, failure and
cancellation all attempt to close the handle and remove the matching claim independently, and
always release the process-local reservation. Cleanup rereads the pathname and preserves any
replacement whose token differs, reporting that the claim now belongs to another owner. An
unwritten or unreadable token also prevents removal. Cleanup failures name the claim path and retain
any restore failure as the primary cause. If the restore completed before cleanup failed, the
error says so explicitly: do not retry that completed restore. A killed process or a failed
unlink can leave its claim file behind.
Domovoi never deletes a claim because it looks old. If the error names a stale claim, stop every
Domovoi process using that worktree root and its supervisor, confirm no restore is active, then
remove only the named claim file. Keep the session worktree, repository and Git refs intact. The
token check catches an already-replaced claim; it is not an atomic compare-and-unlink and does not
make live manual claim deletion safe.

## Terminal dependency

`node-pty` is pinned to the exact prerelease `1.2.0-beta.15`. The stable release, `1.1.0`, failed
to start a PTY on macOS in this daemon (commit `082c2c7`, "fix(terminal): repair macos pty
startup"). The matching upstream defect is https://github.com/microsoft/node-pty/issues/850: the
darwin prebuild shipped `spawn-helper` without the execute bit, so `posix_spawnp` failed under
pnpm. The fix landed in `1.2.0-beta.2` (#858) and `1.2.0-beta.4` (#866). The pin is exact so a
prerelease bump is a reviewed change. Move to the next stable release that contains the fix once
it exists, and verify it on the three CI runners.

Its Linux prebuild selector does not distinguish glibc from musl. The verified bootstrap forces
the reviewed node-pty source build on musl or unknown Linux libc, then checks that the installed
module loads before publishing a runnable receipt. Provide Python, make, a C++ compiler, and
platform headers for that build. Manual package-manager installs do not apply this policy.
`pnpm test:musl` exercises the real packed daemon and a PTY in a pinned Node 22 Alpine container;
it is not a promise about every musl version or architecture.

## License

Apache-2.0 for this package. The Claude Code session adapter has a runtime dependency on
`@anthropic-ai/claude-agent-sdk`, which is proprietary. Domovoi does not redistribute it; npm
installs it under Anthropic's terms. The recorded exception is documented at
https://github.com/getdomovoi/domovoi/blob/main/docs/licensing.md.
