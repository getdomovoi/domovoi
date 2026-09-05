# Local daemon ownership

CLI, supervised startup and Desktop share the current user's `.domovoi` profile. Different
listener ports do not isolate that profile. Stop older daemon and Desktop processes before
upgrading: processes from before this lease protocol do not participate in its exclusion.

## Ownership and discovery

The production factory claims `profile-lease.sqlite` before constructing the workspace store.
This small SQLite file is separate from `state.sqlite`. It holds `BEGIN EXCLUSIVE` with a zero
busy timeout for the owner's lifetime. A losing caller refuses immediately. Explicit shutdown
releases the connection only after the runtime stops; process exit also releases the OS lock.
Neither PID age nor a timestamp authorizes taking ownership. Never delete the lease file to
clear a live owner: another inode could hold an independent lock.

`local-owner.json` is bounded at 16 KiB and atomically published under that lease. Its states
are `starting`, `ready`, `stopping` and `none`. A ready record names the instance, machine,
protocol, owner kind and actual bound endpoint. It carries the credential's source or path,
not the bearer itself. `DOMOVOI_PORT=0` requests an ephemeral port; the record and `start()`
result carry the real port, never zero. `daemon` identifies CLI and supervised owners without
claiming which supervisor launched them. `desktop` identifies an owner acquired by Desktop.

Discovery reads the current record on every attempt. It sends a fresh nonce in the WebSocket
upgrade, without an Authorization header or bearer in the URL. The local owner returns an
HMAC over a domain-separated tuple of instance id, machine id, protocol and nonce. The key
comes from the separate `local-owner.key` file and must differ from the root bearer.
Only after verifying that proof does the same socket send ordinary versioned `system.hello`
with the root credential. Hello must succeed and match the recorded machine. Before returning,
discovery checks that the record still names the same instance and endpoint.

There is no authentication exemption or new public RPC. The optional upgrade proof is served
only to a socket peer on this machine. TLS validation stays enabled; a configured certificate
can supply the local trust anchor, but does not disable certificate or hostname checks. A route
through a remote proxy is not local owner discovery. An environment-supplied root bearer is
never copied into the record; the attaching process must supply that credential in its environment.

On POSIX, the profile directory is `0700` and lease, record and challenge key are `0600`.
Private metadata reads check file ownership, type and bounded size. Windows retains the
existing user-profile ACL policy, without additional ACL restriction. A shared or compromised
OS account is not a security boundary: it may already read the root credential and challenge key.
This mechanism is local instance discovery, not relay encryption or protection from that account.

## Client handle

`acquireLocalDaemon` requires `timeoutMs` and `mode`. Other options are `environment`,
`homeDirectory`, `machineLabel` and `errorSink`. It returns exactly one variant:

| Kind | Handle | Meaning |
| --- | --- | --- |
| `owned` | `endpoint: { url, token }`, `stop()` | This caller owns the runtime. |
| `attached` | `owner: 'daemon' \| 'desktop'`, `endpoint`, `closed: Promise<void>`, `detach()` | Only the discovery socket belongs to this caller. There is no `stop`. |
| `refused` | `reason`, `message` | No replacement daemon was started. |

Refusal reasons are `owner-busy` (owner changed during discovery), `owner-unreachable`,
`owner-incompatible`, `owner-unverified` and `profile-invalid`. The returned message names
the remedy. Never turn any refusal into construction of another daemon or selection of a
different profile.

`attached.closed` resolves when the verification socket closes, including owner shutdown,
connection failure and explicit detach. It never rejects or starts another acquisition. It is
a lifetime notification, not a timed operation. Desktop can subscribe without polling and
choose when to start a new bounded `attach-only` attempt.

Use `start-or-attach` for initial acquisition. It may start Desktop's owner only after observing
a free lease, an absent or `none` record, and no installed service configuration. After attaching,
use `attach-only` on reconnect and call acquisition again, not a cached URL. A stale record,
starting/stopping owner or installed-service restart gap returns `owner-unreachable`, even if
the OS lease is momentarily free. A deliberate CLI/service start can reclaim the free lease
and publish its new instance; Desktop never guesses that the old owner is gone.

One finite monotonic deadline covers each acquisition, including upgrade, proof and hello.
Checks at settlement reject late results even if a timer was delayed. Timeout terminates
the discovery socket. Synchronous metadata work is bounded in size and checked against the
clock at its boundary, but cannot preempt a stalled kernel filesystem operation.
Production setup, startup and shutdown have finite caller waits too. A timed-out startup
cannot publish ready state later. Shutdown waits for the underlying startup to settle before
closing stores, and keeps the lease if the runtime has not actually stopped.

## Service installation and recovery

Install claims the same lease before writing either configuration or registration. If Desktop
owns it, close Desktop, start or install the service, then reopen Desktop and attach. This is a
refusal, not a live ownership handoff. After complete configuration publication, install releases
the lease before starting the service manager. The saved service configuration prevents Desktop
from filling that gap. If publication times out, install keeps the lease until CLI exit because
filesystem work may still settle.

If an owner crashed, restart it explicitly. If a service is no longer wanted, remove its
registration with `domovoid service remove` before asking Desktop to own the profile. Do not
delete ownership metadata while any owner or supervisor may still run. Corrupt or inaccessible
metadata refuses Desktop acquisition until repaired. An explicit CLI/service start may replace
an old owner record only after acquiring the free lease. Neither record age nor a network timeout
is proof that a second writer is safe.

Tests use the real public factory, live sockets, a built child process and SIGKILL to cover
exclusion and rediscovery. They also cover missing/wrong/replayed proofs, ordinary hello
refusals, TLS hostname validation, silent peers and late startup. Provider executable discovery
is stubbed in ownership-focused tests; native supervisor lifecycle behavior still needs its
platform checks. The Desktop integration supplies its own mounted and IPC seam tests.
