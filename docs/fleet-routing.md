# Fleet route deadlines

One caller-owned deadline bounds the whole dial, including credential lookup on the daemon.
Before opening a socket, each attempt gets a child deadline: the remaining milliseconds divided
by the number of eligible routes still to try. The child cannot outlive its parent. A single route
gets the remainder; a fast refusal leaves more time for later routes. Filtering and daemon route
deduplication happen before allocating these shares.

Each share covers connection establishment and authenticated hello together. Neither a successful
upgrade nor a partial answer renews it. The shared client also applies its own connect cap. Once
the overall budget is spent, no later socket is created. A stalled event loop can exhaust the
overall budget before all candidates run; per-route limits do not promise otherwise.

The losing attempt is cancelled before fallback. The daemon terminates its WebSocket; the browser
client closes it, detaches its listeners, rejects pending hello, and cancels its reconnect timer.
Physical socket disposal is still runtime-owned. In particular, Node's browser-style WebSocket
may retain an idle HTTP-pool connection after closing the failed upgrade's socket. A late result
cannot win the dial or revive an abandoned client. Successful connections keep their independent
request budgets after the dial's timers are cleared.

Timeouts remain typed. `TransportDialTimeoutError` extends the shared client's `TransportDialError`
and names the final timed-out route's origin and open, hello, or route-setup stage. The daemon's
`MachineDialTimeoutError` extends `OperationDeadlineExceededError` and names the origin and the
combined `connect-and-hello` wait exposed by its socket adapter. Refusals do not copy transport
error text, bearer credentials, URL userinfo, path, query, or fragment. A later non-timeout failure
is not relabelled as an earlier timeout. Identity, protocol and credential refusals remain terminal
on the daemon; exhausting a route's time is not an authority failure.

`fleet-fallback-sockets.test.ts` uses real listeners that either accept TCP without upgrading or
upgrade without answering hello. Both the shared client and daemon reach an authenticated fallback
inside the original dial budget, and the request-bearing losing socket closes. Deterministic unit
tests cover remaining shares, original-budget exhaustion, late results, timer cleanup, reconnect
cancellation and typed refusals. This does not prove a real tailnet, SSH process or WSL transport.
Remote Fleet Use and Terminal still require the separate client-admission slice.

## Source-local WSL routes

On Windows, an enrolled peer whose authenticated descriptor identifies a WSL distribution gets
a source-local WSL attempt before LAN and tailnet advertisements. An off-host previously verified
direct endpoint still goes first. The source asks its own `wsl.exe` for that distribution, requires
it to be running under WSL 2, and reads its loopback endpoint through `--exec`, never the UNC share.
The endpoint file is a location hint, not evidence of a live daemon. Its root bearer is discarded.
The ordinary paired-machine socket must complete hello with the expected machine identity before
the producer returns the existing discriminated `wsl` candidate and its authenticated connection.

No guest is automatically enrolled. Pair it first over its loopback endpoint. Use distinct ports
for the Windows daemon and guest daemon; `DOMOVOI_PORT=0` picks an available guest port and the CLI
publishes that port in `~/.domovoi/endpoint.json`. A Windows port collision or disabled localhost
forwarding is a refusal, not permission to trust another listener. Custom profiles and TLS-only
guests without the standard loopback endpoint publication are not discovered by this producer.
They can still use an explicitly enrolled non-loopback TLS route or configured SSH forward.

The descriptor must contain the guest's real WSL facts. The CLI obtains the distribution name
from `WSL_DISTRO_NAME`; a launch that removes it appears as plain Linux. In particular, the saved
service launch configuration does not carry that variable today. This branch proves the regular
CLI launch, not a WSL guest launched through `--service-config` or a supervisor that scrubs it.

The successful heartbeat records connection kind `wsl` but never turns its loopback port into a
permanent direct route or target advertisement. Every later dial rechecks the distro and reads
the current port. A remembered loopback enrollment route for a WSL peer on Windows cannot bypass
that check. Remote WSL loopback advertisements are ignored, just like remote SSH advertisements.
Only explicit source-configured SSH forwards may target such a remote loopback hop.

Listing, endpoint read, socket establishment and hello consume one attempt budget inside the
existing overall deadline. A stopped distribution is refused before a guest command or socket
is created, with `WslTransportError.reason = "stopped"`. Other discovery/availability errors are
typed too. Identity, protocol and credential failures stay terminal. Source discovery never asks
to start a distro, but WSL has no atomic list-and-read operation: an operator can stop the guest
between the running observation and its endpoint read. That concurrent host lifecycle race is
not an ownership guarantee and is not claimed by the stopped-distribution test.

The dedicated native job adds a real guest CLI, Windows fleet enrollment, heartbeat and route
dialing, wrong/root credential refusals, a leftover file after SIGKILL, and a stopped guest that
remains stopped. See `docs/wsl-ci.md` for the hosted evidence and limits. This does not add remote
client admission, guest autostart, WSL 1 routing, multi-distro port arbitration, or a relay.
