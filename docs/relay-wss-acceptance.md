# Relay adapter integration evidence

These tests qualify the merged daemon and client relay adapters with synthetic
inputs. They do not establish production browser or desktop relay reachability.
That integration still needs authenticated route provisioning, paired static-key
custody and the platform connection lifecycle described by the D2b follow-up.
No hosted relay, production account, native service or real profile participates.

## Two distinct topologies

| Suite | Real components | Fixture boundary |
| --- | --- | --- |
| `apps/daemon/src/relay-wss-integration.test.ts` | Loopback HTTPS/WSS with certificate verification, daemon outbound carrier, pinned Noise client, daemon RPC and device registry, file-backed SQLite | A small single-route carrier-v1 router forwards opaque frames. The client is the protocol client, not the shared UI. |
| `packages/ui/src/relay-wss-integration.test.ts` | Shared `DomovoiClient`, client relay adapter, pinned Noise admission, signed successor validation and pin CAS | Physical sockets are injected in-memory EventTargets. The responder executes a small schema-validated RPC fixture. No network, daemon or SQLite is present. |

The daemon suite uses its declared `ws` dependency and the existing localhost TLS
fixture. It binds only an ephemeral loopback port and explicitly trusts that
fixture certificate. It does not disable certificate verification. The UI package
has no `ws` dependency, and its test does not borrow one from another package.
These are complementary tests, not an end-to-end UI-to-daemon WSS proof.

The router is not the separate relay repository's server. It exercises carrier
role ordering, recovery publication and bare-client versus multiplexed-publisher
framing. It does not qualify relay authorization, metering, ledger recovery,
backpressure policy, capacity, source limits or hosted operation.

## Observable acceptance cases

- The daemon receives an `annotation.reply` mutation over real WSS and real Noise
  from a device whose paired bearer is bound to its client static key. The reply
  appends a new entry, so executing it twice would produce two distinct effects.
- The fixture withholds outbound encrypted frames, observes the committed SQLite
  entry and held output, then terminates the client socket. The caller observes a
  lost response, not confirmed success. Fresh Noise, `system.hello` and
  `device.current` recover the canonical state without resending the mutation.
- The daemon is stopped, its SQLite connection is closed, and a new daemon and
  store reopen the same task-owned file. The same paired key and credential are
  admitted, the same one reply ID survives, the successful mutation audit count
  remains one, and the publisher registers with a newer durable generation.
  This is a controlled object restart, not SIGKILL, power-loss or native-service
  recovery evidence.
- A different static key with the same paired bearer receives no admitted RPC
  output. This does not turn an opaque remote disconnect into an authenticated
  refusal reason; carrier v1 still cannot distinguish that rejection from link
  loss at the UI boundary.
- Ordered dialing falls through a synthetic direct-network exception into the
  actual encrypted adapter and verified hello/receipt. A terminal direct identity
  refusal never creates a relay adapter. This does not test real route discovery
  or an actual direct network outage.
- The UI integration loses a response after its responder applies a mutation.
  The pending RPC rejects. Its captured retry callback creates a fresh adapter,
  recovery request and Noise channel. The replacement sends only fresh hello
  and receipt requests; it never resends the old mutation. The second snapshot
  remains withheld until the second device receipt. Authentic delayed ciphertext
  delivered to the old socket cannot publish a stale snapshot.
- A signed successor waits for the in-memory CAS acknowledgement before the new
  connection and completes real Noise under the successor private key plus the client receipt check.
  This proves storage acknowledgement ordering, not disk durability.
  Forged signatures and refused CAS produce the fixed local verification refusal,
  no application RPC and no automatic retry.
- Captured opaque frames contain neither the paired bearer nor the mutation text.
  This checks the fixture traffic, not a general side-channel or cryptographic
  audit.

The fault is deliberate response suppression and socket disconnection. It is not
measured network packet loss. The UI responder's mutation count is synthetic;
only the daemon test observes persisted SQLite effects.

## Running and interpreting the tests

Build the existing protocol and credential-store prerequisites, then run:

```sh
pnpm --filter @getdomovoi/ui exec vitest run src/relay-wss-integration.test.ts
pnpm --filter @getdomovoi/daemon exec vitest run src/relay-wss-integration.test.ts
```

Both files are discovered by the existing package test suites. No production
exports, dependencies, test registration or CI configuration are added. These
are test and documentation changes, with no production behavior change.

A deliberate duplicate-RPC probe during development must fail the one-mutation
assertion. That validates the assertion's sensitivity; it is not evidence of a
production regression or a shipping fault injection switch. The probe is removed
before qualification gates.

All waits and attempt policies use finite fixture budgets. Frame counts are
bounded, cleanup closes owned channels/sockets/servers and daemon stores, and
scratch removal follows confirmed cleanup. A cleanup timeout fails and retains
that test's scratch batch rather than claiming resource closure. Later successful
tests cannot remove a retained batch; a synthetic cleanup-failure regression
checks this boundary. JavaScript timers cannot preempt
synchronous SQLite or a stalled event loop; these budgets are not operating SLOs.
Fixture keys and credentials are synthetic. No token, key, RPC content or frame
capture is written to the qualification report.

Remaining acceptance includes real UI network integration, production route and
key custody, desktop worker/ticket/CSP wiring, the actual relay runtime, deployed
restart and outage drills, calibrated timing/error ranges, native platforms,
capacity and multi-day soak. Passing these local tests does not close those gates.
