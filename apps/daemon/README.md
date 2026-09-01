# @getdomovoi/daemon

Execution daemon for Domovoi agent sessions. It owns repository state, terminals, approvals,
artifacts, and the authenticated JSON-RPC endpoint beside the code.

## Install

```bash
pnpm add --global @getdomovoi/daemon
```

The package is standard ESM and can also be installed with npm or Bun.

## Run

```bash
domovoid
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
| `DOMOVOI_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to connect |
| `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1` | Explicitly permits a non-loopback listener |

Every daemon requires authentication. When `DOMOVOI_AUTH_TOKEN` is unset, `domovoid` creates and
reuses a high-entropy credential at `~/.domovoi/daemon.token` with user-only permissions. Remote
listeners also require `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1`. Use an encrypted outer transport such
as a Tailscale tailnet or SSH tunnel. The daemon does not provide TLS itself.

The bearer token protects RPC access. Health checks remain public and preview documents use their
own short-lived signed capabilities.

## Programmatic use

```ts
import { DomovoiDaemon } from "@getdomovoi/daemon"

const daemon = new DomovoiDaemon({ statePath: ":memory:" })
const address = await daemon.start()

console.log(address)
await daemon.stop()
```

## License

Apache-2.0
