# Clean-machine setup

This guide takes an operator from a machine with nothing installed to a supervised `domovoid` that
a client can reach and that a second machine can pair with. It covers the Goal 2 surface: a frozen
runtime installation, first start, the local ownership seam, off-loopback TLS, service supervision
and removal, fleet pairing, machine credentials, and Windows to WSL access.

Every command here exists in this repository today. Steps this repository cannot prove on every
platform are marked under [Limits](#limits). Read that section before planning a rollout.

Audience: the person operating the machine. Repository development is covered by the root
[README](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md) instead.

## Before you start

On the machine that will run the daemon:

- Node.js 22.13.0 or newer, with the npm bundled by that Node distribution at 10.0.0 or newer.
  The daemon declares `"node": ">=22.13.0"` in `apps/daemon/package.json`, and unflagged
  `node:sqlite` needs that version.
- `tar` on `PATH`.
- A native build toolchain, because `node-pty` is compiled during installation.
- Outbound HTTPS to the npm registry.
- A user account you are willing to run the daemon as. Nothing below asks for elevation and
  nothing is written to a system-wide location.

Domovoi keeps its per-user state under `~/.domovoi` on Linux and macOS, and under `.domovoi` in
the user profile directory on Windows. That directory holds the daemon credential, machine
identity, profile lease, owner record, and saved service configuration.

## Step 1: install a daemon runtime

Two routes exist. Route A is the supported frozen installation. It needs a published release, and
this repository publishes none yet, so use route B until the first release exists. Both routes end
with a directory containing `dist/index.js`, which every later step calls.

### Route A: verified bootstrap from a published release

```bash
node scripts/bootstrap-daemon.mjs <version> <baseUrl> <destination> <expectedSha256>
```

`<destination>` is a directory. Bootstrap writes the archive to
`<destination>/v<version>/getdomovoi-daemon-<version>.tgz`, installs into a private
`<destination>/v<version>/.runtime-*/package` directory, and publishes the receipt
`<destination>/v<version>/runtime.json` only after verification succeeds. The command prints JSON
whose `runtimePath` names that installed directory.

Both the release `SHA256SUMS` and the SHA-256 you pass must match the archive bytes. Obtain the
digest through a channel independent of the archive. Installation materialises the archive's
embedded integrity lock as `package-lock.json`, runs `npm ci --omit=dev --ignore-scripts` with the
npm bundled beside the Node executable running bootstrap, verifies the installed graph against the
lock, and permits only the reviewed `node-pty` native build. Download, installation, native build,
verification, publication, and cleanup share one five-minute budget.

Bootstrap installs a runtime tree. It does not create a `domovoid` command on `PATH`, start the
daemon, configure daemon state, or install supervision. Steps 2 onward do that.

Release checksums and CycloneDX SBOMs are produced by `pnpm release:artifacts`, which writes
`release/<package>-<version>.tgz`, `release/<package>-<version>.sbom.json`, and
`release/SHA256SUMS` in a repository checkout. Signature verification of release artifacts is not
implemented yet.

The full contract, including what freezing does not promise, is
[the distribution contract](distribution.md).

### Route B: build from a repository checkout

Use this while no release is published. It additionally needs Git and pnpm 11.

```bash
git clone https://github.com/getdomovoi/domovoi.git
cd domovoi
pnpm install
pnpm --filter @getdomovoi/daemon build
```

The runtime directory is then `apps/daemon` and its entry point is `apps/daemon/dist/index.js`.
This route resolves dependencies with pnpm at the moment you run it. It is not the frozen
installation route A provides.

## Step 2: fix the command you will keep using

There is no installer that writes a `domovoid` shim. Choose one absolute entry-point path and use
it everywhere, because service installation records the Node executable and the entry-point path
it was invoked with, and a later reinstall from a different path replaces that launch command.

Linux and macOS:

```bash
DOMOVOID=/absolute/path/to/runtime/dist/index.js
domovoid() { node "$DOMOVOID" "$@"; }
```

Windows PowerShell:

```powershell
function domovoid { node C:\absolute\path\to\runtime\dist\index.js @args }
```

Check the entry point answers before continuing:

```bash
domovoid --version
domovoid --help
```

`--help` prints every subcommand and environment variable this guide uses.

## Step 3: first start on loopback

```bash
domovoid
```

The daemon listens on `127.0.0.1:47831` by default and prints its URL. With `DOMOVOI_AUTH_TOKEN`
unset it creates a private bearer file at `~/.domovoi/daemon.token` and prints that path. Treat
that file as a root credential.

One process owns the profile. The daemon claims `~/.domovoi/profile-lease.sqlite` before it opens
its state store, and publishes `~/.domovoi/local-owner.json` describing the running owner. A second
`domovoid`, or Desktop, does not start a competing daemon: it attaches to the owner or refuses with
a named reason. Different ports do not create separate profiles. Never delete the lease file to
clear an owner that is still running. The rules are in
[local daemon ownership](local-daemon-ownership.md).

While the daemon runs, open a workspace on this machine:

```bash
domovoid open .
domovoid open /path/to/project
```

Stop the daemon with Ctrl-C before moving on. It removes its endpoint file and owner record on a
clean shutdown.

## Step 4: reach the daemon from another machine

Loopback is enough for a client on the same machine. A remote client or a fleet peer needs a
non-loopback TLS listener, which the daemon refuses to start without all of these:

| Variable | Required for a remote listener |
| --- | --- |
| `DOMOVOI_ALLOW_REMOTE_TRANSPORT=1` | Explicit opt-in to a non-loopback listener |
| `DOMOVOI_HOST` | The address to bind, for example `0.0.0.0` or a tailnet address |
| `DOMOVOI_TLS_CERT_PATH` | Certificate chain valid for the name clients will dial |
| `DOMOVOI_TLS_KEY_PATH` | Matching private key |

Add exactly one of these so the daemon advertises a name rather than a bound address:

- `DOMOVOI_ADVERTISE_HOST` for a LAN name.
- `DOMOVOI_TAILNET_HOST` for a tailnet name or address. It takes a bare host, not a URL or port.

Set `DOMOVOI_ALLOWED_ORIGINS` to a comma-separated list of browser origins if a browser client
will connect. The daemon terminates TLS itself and refuses a plaintext non-loopback listener.
Domovoi does not obtain certificates, configure DNS, or verify tailnet membership. A name is never
treated as proof of transport protection.

Example, adjusting paths and names for your machine:

```bash
DOMOVOI_ALLOW_REMOTE_TRANSPORT=1 \
DOMOVOI_HOST=0.0.0.0 \
DOMOVOI_TLS_CERT_PATH=/home/me/.domovoi/tls/fullchain.pem \
DOMOVOI_TLS_KEY_PATH=/home/me/.domovoi/tls/privkey.pem \
DOMOVOI_TAILNET_HOST=workshop.example.ts.net \
domovoid
```

Every connection is authenticated whatever the transport, including inside a tailnet.

## Step 5: install supervision

Run the install with the environment you intend the service to keep, because installation captures
the current non-secret configuration and the service uses that file rather than the supervisor's
environment on every start.

Close every other daemon owner first, including Desktop. Installation claims the same profile lease
and refuses rather than taking ownership from a running process.

```bash
domovoid service install
domovoid service status
```

`install` writes a systemd user unit on Linux, a launch agent under the user's own `LaunchAgents`
on macOS, or a logon task on Windows, then asks that manager to load it. It also writes
`~/.domovoi/service.json` holding a fresh registration UUID, the listener host and port, the remote
opt-in, TLS certificate and key **paths**, advertised host, allowed origins, credential and machine
identity paths, and the home directory used for durable state. No bearer, TLS key contents, or
provider credential is written to it.

An install refuses before writing anything if `DOMOVOI_AUTH_TOKEN` is set. Point
`DOMOVOI_CREDENTIAL_PATH` at an existing private credential file, unset the environment bearer,
then install again.

`status` reports whether the service file exists and whether the manager currently runs it, and
exits non-zero when nothing is installed. Reopen Desktop after the service is running and it will
attach to the service-owned daemon.

To change settings later: stop the service, run `domovoid service install` again with the intended
environment, then start it. Editing the environment of the supervisor alone changes nothing,
because the service reads `~/.domovoi/service.json`.

To remove it:

```bash
domovoid service remove
```

`remove` stops the manager job, deletes the launch files, and deletes the saved configuration. On
Windows it disables the task and waits for Task Scheduler to report it stopped before deleting it.
It does not remove the credential, machine identity, workspace database, or worktrees. Lifecycle
detail and its limits are in [daemon service configuration](daemon-services.md).

Install, status, and remove each take an exclusive operation lease at
`~/.domovoi/service-operation-lease.sqlite` and each shares one 30 second budget. A competing
command fails immediately and names that file. Never delete or replace it.

## Step 6: add provider credentials

```bash
domovoid secret status
domovoid secret set anthropic
domovoid secret delete anthropic
```

The supported provider names are `anthropic`, `openai`, and `openrouter`. `set` reads the secret
from the terminal without echoing it. Provider CLIs and provider services are installed and
licensed separately from Domovoi.

## Step 7: pair a second machine

Pairing is direct only. The machine being added needs the reachable TLS listener from step 4, and
the machine you pair from needs a client that can reach it.

On the machine being added:

```bash
domovoid pair
```

It prints a single-use pairing code that lasts three minutes. In the client on the machine you are
pairing from, open the fleet view, choose to pair a machine, and supply three values:

- Machine address, the target's RPC URL, for example `wss://workshop.example.ts.net:47831/rpc`.
- The pairing code printed above.
- A name for this device.

Peer credentials are stored in the OS keychain of the source machine, never in the workspace
snapshot. Pairing does not grant remote Use or Terminal access on its own; that is a separate
admission step. Claims are rate limited per source address and across the listener, and a wrong
code is spent after five guesses.

If a source machine's keychain index needs repair, stop Domovoi and its supervisor first, then:

```bash
domovoid fleet-keychain list
domovoid fleet-keychain forget <machine-id> --confirm-daemon-stopped
```

`list` prints indexed machine IDs and never credential bytes. `forget` removes only the named local
key and index entry. It does not revoke this machine on the target: revoke it in the target's
Devices list as well. `--confirm-daemon-stopped` is your assertion, not a check Domovoi performs.

If an already enrolled peer is reachable only through an SSH local forward you maintain yourself,
name it on the source daemon:

```bash
DOMOVOI_SSH_TUNNELS='[{"machineId":"machine-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","endpoint":"ws://127.0.0.1:47900/rpc"}]' domovoid
```

Domovoi does not launch SSH, manage its credentials, or verify which program created the forward.
The endpoint must be a loopback address. Service installation saves this setting into
`service.json`, so removing it from the supervisor's environment alone leaves it active.

## Step 8: Windows and WSL

A daemon inside a WSL distribution is a separate machine with its own credential and its own
`~/.domovoi`. Install and start `domovoid` inside the distribution using steps 1 to 3, run inside
that distribution. It publishes its loopback endpoint at `~/.domovoi/endpoint.json` there, and
WSL 2 forwards that port to the Windows loopback.

From Windows:

```powershell
domovoid wsl list
domovoid open \\wsl$\Ubuntu-24.04\home\me\project
domovoid open .
```

`wsl list` runs `wsl.exe --list --verbose` and asks each running distribution to read its endpoint
file. It prints one line per distribution with the name, WSL version, running state, and either the
daemon address, `no daemon`, or `could not be asked`. The credential in the endpoint file is never
printed. A stopped distribution is not asked, because asking would start it.

`open` on a `\\wsl$\<distribution>\...` or `\\wsl.localhost\<distribution>\...` path resolves the
path through that distribution's own `wslpath` and sends the request to the daemon inside the
distribution, using that daemon's credential. The Windows machine's credential never travels into a
distribution. It refuses, naming the distribution and the remedy, when the distribution is not
installed, is stopped, runs under WSL 1, has no daemon endpoint, or when the path is a Windows
drive the distribution mounts. A plain Windows path opens through the Windows daemon.

No repository work runs through `\\wsl$`. Every daemon refuses `project.open` on such a path and
names `domovoid open` as the way in.

Discovery does not enroll a distribution in the fleet. To add it, run `domovoid pair` inside the
distribution and pair it like any other machine, per step 7.

## Recovery

If a daemon was killed, or a custom supervisor started it without a service registration, the
profile can be left owned by a process that no longer exists. Stop and remove every supervisor that
could restart it, confirm no daemon is running, then:

```bash
domovoid profile recover --confirm-no-supervisor
```

The flag is your assertion that nothing will restart that profile. The command refuses while any
owner holds the lease or a saved service configuration remains; use `domovoid service remove` for
the latter. It records the assertion and does not start a daemon. Reopen Desktop afterwards to
consume the receipt.

An absent `service.json` proves nothing on its own, and no timestamp or process age authorizes
taking ownership. Do not delete `~/.domovoi/profile-lease.sqlite` or `~/.domovoi/local-owner.json`
while any owner or supervisor may still be running.

An interrupted bootstrap can leave `.bootstrap-*` or `.runtime-*` directories under
`<destination>/v<version>`. Stop bootstrap and any remaining build process before removing one
exact unpublished directory by hand. Never remove a directory named by `runtime.json` while its
daemon runs. Nothing is cleaned up by age.

## Limits

Read these before relying on this guide for a fleet rollout.

- No release is published from this repository yet, so route A cannot be exercised against a real
  release today. The release workflow stays inert until publishing is enabled.
- There is no packaged installer, PATH shim, Homebrew formula, AUR package, or Windows package
  manifest. Step 2 exists because nothing installs a `domovoid` command for you.
- Signature verification of release artifacts is not implemented. Checksums are not authenticity.
- Native compilation and the external toolchain are not frozen by the integrity lock. Neither are
  separately installed provider CLIs.
- Service installation is proven by configuration round-trip, concurrency, and focused Windows
  removal tests, not by full native systemd, launchd, or Task Scheduler lifecycle acceptance. A
  timed-out manager command may already have changed OS state; inspect the manager before retrying.
- Windows crash restart of the logon task is not configured.
- The WSL steps are exercised by unit tests that stub `wsl.exe`. There is no real
  Windows-to-WSL test, and the WSL mount-boundary guard assumes Windows drives are mounted under
  `/mnt`.
- WSL distributions are not fleet transport candidates. Only local, LAN, explicitly configured TLS
  tailnet, and source-local SSH routes are produced today. Relay is not implemented.
- Fleet health reporting covers revocation. Version mismatch and upgrade-required states have no
  production proof yet.
- A shared or compromised OS account is not a security boundary. It can already read the daemon
  credential.

## Related documents

- [Distribution contract](distribution.md): archive verification, the frozen install, and what
  freezing does not promise.
- [Daemon service configuration](daemon-services.md): saved settings, leases, deadlines, and
  Windows removal.
- [Local daemon ownership](local-daemon-ownership.md): lease, owner record, discovery proof, and
  the recovery receipt.
- [Daemon package README](../apps/daemon/README.md): every environment variable, fleet enrollment
  detail, skill signing, and programmatic use.
