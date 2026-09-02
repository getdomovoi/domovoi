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

## Terminal dependency

`node-pty` is pinned to the exact prerelease `1.2.0-beta.15`. The stable release, `1.1.0`, failed
to start a PTY on macOS in this daemon (commit `082c2c7`, "fix(terminal): repair macos pty
startup"). The matching upstream defect is https://github.com/microsoft/node-pty/issues/850: the
darwin prebuild shipped `spawn-helper` without the execute bit, so `posix_spawnp` failed under
pnpm. The fix landed in `1.2.0-beta.2` (#858) and `1.2.0-beta.4` (#866). The pin is exact so a
prerelease bump is a reviewed change. Move to the next stable release that contains the fix once
it exists, and verify it on the three CI runners.

## License

Apache-2.0 for this package. The Claude Code session adapter has a runtime dependency on
`@anthropic-ai/claude-agent-sdk`, which is proprietary. Domovoi does not redistribute it; npm
installs it under Anthropic's terms. The recorded exception is documented at
https://github.com/getdomovoi/domovoi/blob/main/docs/licensing.md.
