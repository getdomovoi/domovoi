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
