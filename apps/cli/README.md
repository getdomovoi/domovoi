# @getdomovoi/cli

`domovoi` is the terminal client for a Domovoi daemon. It pairs with a daemon once, then talks to
it over the daemon's WebSocket JSON-RPC endpoint with its own client credential. It runs nothing on
the machine itself; the daemon does that.

The daemon's own binary is `domovoid`, in `@getdomovoi/daemon`. Installing, supervising and
pairing a daemon are `domovoid` commands. See [`docs/cli-parity-decision.md`](../../docs/cli-parity-decision.md)
for which commands live where.

## Commands

```text
domovoi pair   [--daemon <ws-url>] [--credential-file <path>]   reads the credential from stdin
domovoi status [--daemon <ws-url>] [--credential-file <path>]
domovoi doctor [--daemon <ws-url>] [--credential-file <path>]
domovoi logs   [--limit <n>] [--action <name>] [--outcome <o>] [--session <id>] [--before <id>]
domovoi skill install <path> [--scope user|project] [--yes]
```

- `pair` stores a client credential for one daemon. On the machine that runs the daemon, run
  `domovoid pair --client cli`; it prints one client credential. Paste that line, or the credential
  alone, into `domovoi pair`. The credential is read from stdin so it does not land in shell
  history or the process table.
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

`--daemon` defaults to the local daemon's loopback endpoint. `--help` prints the same usage.

## Where credentials live

Credentials are kept in the OS keychain through `@getdomovoi/credential-store`. Where there is no
keychain, such as a headless host, WSL or a container, pass `--credential-file <path>` to keep them
in a file you own. The CLI never creates that file unless you name it.

## Exit codes

- `0`: the command succeeded, or usage was requested.
- `1`: a probe failed, the daemon was unreachable, pairing or credential storage failed, or a skill
  install was declined or refused.
- `2`: a usage error, an unknown command, or no stored credential for that daemon.
