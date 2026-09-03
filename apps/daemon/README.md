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

The package is standard ESM, but npm, pnpm, and Bun registry installation will only be supported
after publication.

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
reuses a high-entropy credential at `~/.domovoi/daemon.token` with user-only permissions. Remote
listeners also require `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1` plus `DOMOVOI_TLS_CERT_PATH` and
`DOMOVOI_TLS_KEY_PATH`, which must be set together. The daemon terminates TLS itself and refuses
to start a plaintext non-loopback listener.

The bearer token protects RPC access. Health checks remain public and preview documents use their
own short-lived signed capabilities.

## Programmatic use

The package has two entry points. `@getdomovoi/daemon` is the supported surface: one class, and
the options that configure a listener and its credentials. `@getdomovoi/daemon/internal` exposes
the whole server module, including the dependency-injection seams the daemon's own tests use. It
carries no compatibility promise and can change in any release.

```ts
import { DomovoiDaemon } from "@getdomovoi/daemon"

const daemon = new DomovoiDaemon({
  host: "127.0.0.1",
  port: 47831,
  statePath: ":memory:",
  errorSink: ({ context, detail }) => console.error(context, detail),
})

const address = await daemon.start()
console.log(address, daemon.authToken)

await daemon.stop()
```

`DomovoiDaemonOptions` accepts:

| Option | Purpose |
| --- | --- |
| `host` | Listener host, `127.0.0.1` by default |
| `port` | Listener port, `47831` by default |
| `advertiseHost` | Name an encrypted listener is advertised as reachable by |
| `allowedOrigins` | Browser origins allowed to connect |
| `allowRemoteTransport` | Permits a non-loopback listener |
| `tls` | Certificate chain and key for a non-loopback listener |
| `authToken` | Bearer token required by RPC requests |
| `authTimeoutMs` | Time a connection has to authenticate |
| `statePath` | SQLite state file, or `:memory:` |
| `worktreeRoot` | Directory worktrees are created under |
| `agentTimeoutMs` | Time a provider turn may take |
| `errorSink` | Receives daemon failures as `{ context, detail }` |

A started daemon exposes `host`, `requestedPort`, `allowedOrigins`, `authToken`, `start()`, and
`stop()`. Anything beyond that lives on the internal entry:

```ts
import { DomovoiDaemon, type DaemonServerOptions } from "@getdomovoi/daemon/internal"
```

## License

Apache-2.0
