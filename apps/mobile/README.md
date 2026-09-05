# @getdomovoi/mobile

The Domovoi phone app. It connects to one `domovoid` over your tailnet, shows that daemon's
sessions and approvals, and lets you approve, send a turn, pause, and read plans and diffs. During
development it runs inside Expo Go.

## Before you start

- Node.js 22.13 or newer and pnpm 11, from `engines` and `packageManager` in the root
  `package.json`.
- Expo Go on the phone. The app is built on Expo SDK 57 (`expo ~57.0.20` in
  `apps/mobile/package.json`), so install an Expo Go release that runs SDK 57.
- A daemon the phone can reach. Its setup is under [Reach the daemon](#reach-the-daemon).

## Start the dev server

From the repository root:

```bash
pnpm install
pnpm --filter @getdomovoi/mobile start
```

`start` runs `expo start`. Its `prestart` hook builds `packages/protocol` first, because the app
imports `@getdomovoi/protocol` from that package's `dist/`. `apps/mobile/metro.config.js` points
Metro at the workspace root and both `node_modules` directories so the shared package resolves.

Open the QR code the terminal prints with Expo Go. The phone loads the app from Metro on your
computer, and Metro advertises your computer's local network address by default (`--host lan` in
`expo start --help`). If the phone only reaches your computer over the tailnet, advertise that
address instead:

```bash
REACT_NATIVE_PACKAGER_HOSTNAME=<your computer's tailnet address> \
  pnpm --filter @getdomovoi/mobile start
```

Expo CLI 57 reads that variable in `@expo/cli/build/src/start/server/UrlCreator.js` and marks it
undocumented, so check the URL the terminal prints before scanning.

## Reach the daemon

The app opens one WebSocket to the daemon's JSON-RPC endpoint and greets it with your token
(`apps/mobile/src/lib/daemon.ts`). The address is the daemon's WebSocket URL, which `domovoid`
prints when it starts, as `domovoid listening on <url>` (`apps/daemon/src/index.ts`):

```text
ws://127.0.0.1:47831/rpc     the default loopback listener, plaintext
wss://<host>:47831/rpc       any other listener, TLS
```

### Over the tailnet

A loopback listener cannot be reached from a phone, so run the daemon on the machine's tailnet
address. `apps/daemon/src/config.ts` refuses a non-loopback `DOMOVOI_HOST` unless both of these
hold:

- `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1` is set.
- `DOMOVOI_TLS_CERT_PATH` and `DOMOVOI_TLS_KEY_PATH` are both set. The daemon terminates TLS itself
  and never starts a plaintext listener off loopback.

`apps/daemon/src/tls-material.ts` wants PEM files: the certificate must contain
`BEGIN CERTIFICATE`, the key must contain `PRIVATE KEY`, and on Linux and macOS the key file must
not be readable by group or others (`chmod 600`). The phone dials with the platform WebSocket and
adds no trust of its own, so the certificate has to be one the phone already trusts, issued for the
name you put in the address. `tailscale cert <domain>` writes `<domain>.crt` and `<domain>.key`
(`tailscale cert --help`); use the machine's tailnet DNS name as the domain.

Build the daemon once, then start it on the tailnet address:

```bash
pnpm --filter @getdomovoi/daemon build
DOMOVOI_HOST=<the machine's tailnet IPv4 address> \
DOMOVOI_ALLOW_REMOTE_TRANSPORT=1 \
DOMOVOI_TLS_CERT_PATH=<path to the .crt> \
DOMOVOI_TLS_KEY_PATH=<path to the .key> \
pnpm --filter @getdomovoi/daemon start
```

The daemon binds exactly the host you give it (`apps/daemon/src/server.ts`). In the phone, dial
the name on the certificate: `wss://<domain>:47831/rpc`.

### The pairing token

Every daemon requires a credential. The phone sends the token you enter in its greeting, and the
daemon accepts it when it is the daemon's own credential or a device credential paired for a phone
(`#credentialAccepted` in `apps/daemon/src/server.ts`). The phone has no pairing-code flow, so use
the daemon's own credential:

- With `DOMOVOI_AUTH_TOKEN` unset, `domovoid` creates it at `~/.domovoi/daemon.token` and prints
  `domovoid credential stored at <path>` on start. The file holds one line. Copy it.
- With `DOMOVOI_AUTH_TOKEN` set, that value is the token.

It is a 43-character base64url string (`apps/daemon/src/config.ts`). It can do anything on that
machine, and Settings says so above the field. `domovoid pair` prints a pairing code for other
clients; the phone cannot claim one.

## Settings

Open the Settings tab (`apps/mobile/src/screens/settings.tsx`):

- Daemon address: the WebSocket URL from above.
- Pairing token: masked while you type. No text on the screen repeats it.
- Connect: trims both fields, saves them, and opens the connection (`apps/mobile/src/app.tsx`).
  The pair is saved before the daemon answers, so a wrong token stays saved until you change it or
  forget the daemon.
- Forget this daemon: clears both fields, closes the connection, and deletes the saved pair.

The line under the buttons reads Connecting, Connected, or Not connected. When the daemon refuses
the token, or the phone and the daemon speak different protocol versions, the app stops retrying
and says why (`apps/mobile/src/lib/connection-fault.ts`). Fix the token or update the older side,
then press Connect again. Every other failure is retried on its own, with delays from 1 second up
to 30 seconds (`apps/mobile/src/lib/reconnect.ts`), and again as soon as the app returns to the
foreground (`apps/mobile/src/lib/use-daemon.ts`). A request the daemon accepts but never answers
fails after 30 seconds, or 15 seconds for the first workspace read (`apps/mobile/src/lib/request-timeout.ts`).

## What the phone stores

Two values, written through `expo-secure-store` to the device keychain
(`apps/mobile/src/lib/credentials.ts`):

| Key | Holds | Access |
| --- | --- | --- |
| `domovoi.daemon.url` | the daemon address | store default |
| `domovoi.daemon.token` | the pairing token | `WHEN_UNLOCKED_THIS_DEVICE_ONLY` |

Forget this daemon removes both. Nothing else is written to the phone: sessions, approvals, plans,
and diffs live in memory from the daemon's snapshot and are gone when the app restarts.

## Limits today

- One daemon at a time. Settings holds one address and one token.
- No pairing flow on the phone. It takes the daemon credential; it cannot claim a pairing code
  (`ROADMAP.md`, Goal 3).
- Fleet lists the machines paired with the daemon and their health. Use and Terminal on a remote
  machine are not admitted yet on any client (`ROADMAP.md`, "Admit a client to an enrolled remote
  daemon").
- No terminal on the phone. A terminal artifact is listed with a note that it is watched on the
  desktop (`apps/mobile/src/artifact-rows.ts`). A preview needs a signed fetch the phone cannot
  make yet. Plans and diffs render up to 400 lines and count the rest.
- Session transfer is not offered from the phone (`apps/mobile/src/lib/request-timeout.ts`).
- Dark theme only (`apps/mobile/tailwind.config.js`).
- The fonts ship in the bundle. If they have not loaded after 3 seconds, the app draws with the
  platform font (`apps/mobile/src/theme/font-gate.ts`).

## Check the bundle builds

```bash
pnpm --filter @getdomovoi/mobile build
```

`build` runs `expo export --platform ios --output-dir dist` after its `prebuild` hook builds the
protocol package. It writes the Hermes bundle under `apps/mobile/dist/`, which is git-ignored, and
prints the bundle path and size. Root `pnpm build` runs it too.
