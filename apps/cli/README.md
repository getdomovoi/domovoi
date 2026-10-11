# @getdomovoi/cli

`domovoi` is the terminal client for a Domovoi daemon. It pairs with a daemon once, then talks to
it over the daemon's WebSocket JSON-RPC endpoint with its own client credential. Apart from
`domovoi daemon`, it runs nothing on the machine itself; the daemon does that.

The daemon's own binary is `domovoid`, in `@getdomovoi/daemon`, which this package depends on.
`domovoi daemon install|status|remove` runs that package's own service installer; issuing a
pairing code and the other daemon-side commands are still `domovoid` commands. See
[`docs/cli-parity-decision.md`](../../docs/cli-parity-decision.md) for which commands live where.

## Commands

```text
domovoi pair   [--daemon <ws-url>] [--credential-file <path>] [--label <device label>]   reads the pairing code from stdin
domovoi status [--daemon <ws-url>] [--credential-file <path>]
domovoi doctor [--daemon <ws-url>] [--credential-file <path>]
domovoi logs   [--limit <n>] [--action <name>] [--outcome <o>] [--session <id>] [--before <id>]
domovoi skill install <path> [--scope user|project] [--yes]
domovoi daemon install|status|remove
```

- `pair` redeems a pairing code and stores the client credential the daemon mints for one
  daemon. On the machine that runs the daemon, `domovoid pair --client cli` prints a one-time
  code, the same way it does for a phone: a symbol to scan and, under "Cannot scan it?", a
  `domovoi-pair:1:` line that carries the daemon's address. Paste that line, or the
  bare code, into `domovoi pair`. It reads stdin, so the code does not land in shell history or
  the process table. The code is spent with `device.redeemCode` on a socket that holds no
  credential yet, the minted credential is proven with an authenticated hello, and only then is
  it kept. A code issued for another kind of client is refused and nothing is stored. Once the
  code is spent, the daemon lists the device under its label whatever happens next; when the
  hello is refused or the credential cannot be stored, the message names that device so it can
  be revoked before another code is shown. `--label`
  names this device in the daemon's Devices list and defaults to the hostname; either is checked
  against the wire's bound of 1 to 128 characters before the code is read, because the daemon
  counts a refused label as one of the three admissions below. The pasted line's
  address is used unless `--daemon` is given; the credential is keyed by that address, the
  success line prints it, and when it is not the default it says that later commands need
  `--daemon` with it. The daemon admits three redemptions per source per
  minute, successful ones included, and each code works once.
- `status` reports the paired daemon's state.
- `doctor` checks the daemon, the stored credential and the protocol version, then reports, for
  each fleet machine, the route this daemon would choose and why the others lost. It exits 1 on
  any failed probe.
- `logs` reads your copy of the machine's audit log over your own connection. It is a paged query
  with no `--follow`; page with `--before`. `--limit` takes 1 to 500 and defaults to 50.
- `skill install` takes an absolute path, because the daemon reads it rather than this shell. It
  previews the files, digests, signature, trust state and target, asks before installing unless
  `--yes` is given, then installs the previewed digest into the chosen scope. Enabling the skill is
  a separate decision made on the daemon.
- `daemon install`, `daemon status` and `daemon remove` register, report on or remove the login
  service that runs this machine's daemon for your user: a systemd user unit, a launch agent, or a
  Windows logon task. They call `runDaemonCommand` from `@getdomovoi/daemon/daemon-command`, the
  same code as `domovoid service install|status|remove`, so the service runs the daemon's
  `dist/index.js`, never this CLI. `install` saves the non-secret daemon settings of the shell it
  runs in. Their follow-up lines name `domovoi daemon` commands. Where the daemon package is not
  installed beside this CLI, as in the desktop app's runtime, the CLI loads the one daemon at
  `../../daemon/dist/daemon-command.js` from its own `dist`, and refuses when that is absent too.
  See [`docs/daemon-services.md`](../../docs/daemon-services.md).

`--daemon` defaults to the local daemon's loopback endpoint. `--help` prints the same usage.

## Where credentials live

Credentials are kept in the OS keychain through `@getdomovoi/credential-store`. Where there is no
keychain, such as a headless host, WSL or a container, pass `--credential-file <path>` to keep them
in a file you own. The CLI never creates that file unless you name it.

## Exit codes

The table from the CLI transcripts design, adopted whole before 1.0 (ruling Q391 A). The numbers
are stable across releases, so scripts can branch on them. Unconfirmed and failed never share a
code. Nothing below 10 is about the session; 10 and up are what happened to it. `--help` prints
the same table. The source is `src/exit-codes.ts`.

| Code | Name | When | Returned by |
| --- | --- | --- | --- |
| 0 | `ok` | The command did what it said: session created, message sent, decision recorded, or the watched turn ended done. | all |
| 1 | `internal` | An unexpected error in the CLI. The message is printed. | all |
| 2 | `usage` | A bad flag, argument or quoting. Nothing was sent. | all |
| 3 | `daemon-unreachable` | Could not reach the daemon before doing anything. Nothing was sent. | all |
| 4 | `not-found` | No session or approval with that id on any reachable machine. | send, watch, approve, deny |
| 5 | `not-paired` | No credential is stored for that daemon. Nothing was sent. | all but pair |
| 10 | `gate-waiting` | watch --no-prompt reached a gate. The facts and approval id are printed. | watch --no-prompt |
| 11 | `turn-failed` | The agent ended the turn on a failure it reported. | watch |
| 12 | `refused-by-policy` | The turn stopped at a policy refusal. | watch |
| 21 | `connection-lost` | watch lost the daemon mid-turn and gave up reconnecting. Calls in flight are unconfirmed, not failed. | watch |
| 22 | `stopped-unconfirmed` | The turn stopped because a tool call has no recorded result. | watch |
| 31 | `already-decided` | Someone already answered this gate. The existing receipt is printed and nothing changes. | approve, deny |
| 32 | `not-permitted` | This device's credential can watch but not decide. | approve, deny, watch |
| 33 | `needs-a-person` | approve on a hard gate with no terminal attached. Nothing was approved. | approve |
| 130 | `detached` | Ctrl-C in watch. The session keeps running on its machine. | watch |

Two notes against the design's table. `not-paired` (5) is not drawn there; the ruling asks for a
named code for an unpaired client, which this CLI returned as usage (2) before. The design's row
for 1 says a log path is printed; this CLI keeps no log, so that clause is left out.

What the commands that exist today return: `pair`, `status`, `doctor`, `logs` and
`skill install` exit 0, 2, 3 and 5 as the table says. `doctor` exits 1 on a failed probe, and
`skill install` exits 1 when the install is declined or refused; `pair` exits 1 when the daemon
refuses the code or the credential cannot be stored. `daemon install`, `daemon status` and
`daemon remove` keep the exit codes of `domovoid service`: `status` exits 0 when the service is
installed, even if it is stopped, and 1 when it is not or its supervision failed; `install` and
`remove` exit 0 on success and 1 on failure. A verb they do not have exits 2. Codes 4 and 10 to
130 belong to the session commands (`session new`, `send`, `watch`, `approve`, `deny`), which are
not built yet; the numbers are fixed here so they do not move when those land.
