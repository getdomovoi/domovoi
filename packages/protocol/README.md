# @getdomovoi/protocol

Typed schemas and shared types for the Domovoi daemon and clients.

## Workspace use

`@getdomovoi/protocol` is not currently published to a package registry. Until the first release,
use it from this repository's pnpm workspace. Other workspace packages depend on it with
`workspace:*`.

```bash
pnpm install
pnpm --filter @getdomovoi/protocol build
```

The package is standard ESM, but npm, pnpm, and Bun registry installation will only be supported
after publication.

## Usage

```ts
import { protocolVersion, rpcRequestSchema, workspaceSnapshotSchema } from "@getdomovoi/protocol"

const request = rpcRequestSchema.parse(input)
const snapshot = workspaceSnapshotSchema.parse(response)

console.log(protocolVersion, request, snapshot)
```

The package exports the versioned JSON-RPC schemas, workspace and session types, preview bridge
messages, and test fixtures used by Domovoi implementations.

## RPC surface

`rpcMethods` is the whole method surface. Every method is also classified in `rpcMethodMutations`
as `mutating` or `read-only`:

- `mutating` means handling the method is expected to change state the daemon has to write to
  disk.
- `read-only` means the method only reads, or only changes live process state that a restart would
  discard anyway. Terminal methods are read-only under this definition: a terminal is a running
  process, never a stored record.

`isMutatingRpcMethod` and `isRefusedWithoutPersistence` read that table. Use the table rather than
guessing from a method name, because the classification is part of the wire contract.

### Diagnostic and test-harness methods

`workspace.get` returns the current workspace snapshot and takes no parameters. It is a diagnostic
and test-harness method. Clients are not expected to call it in normal operation: every connection
already receives the same snapshot from `system.hello`, and a client resyncs by sending
`system.hello` again after a reconnect. A client that never calls `workspace.get` is behaving
correctly, not missing a call.

It stays classified `read-only`, so it keeps answering while the daemon is refusing changes, which
is exactly when an operator wants to read the state that is not reaching disk.

### Refusal while persistence is unavailable

`daemonPersistenceUnavailableErrorCode` (`-32014`) means the daemon can no longer persist state. A
daemon that has failed to write repeatedly returns this code instead of accepting work whose result
would never reach disk.

- read-only methods keep working, so clients can still read, diagnose, and export;
- mutating methods are refused with `-32014`;
- the mutating methods in `persistenceRecoveryRpcMethods` (`system.pauseAll`, `session.pause`,
  `system.emergencyStop`) are still accepted, because they exist to reduce what an unpersisted
  daemon is still doing.

A daemon leaves the refusing state as soon as one write succeeds. Snapshots are written whole
rather than as a diff, so a single successful write carries everything the failed writes did not.

## License

Apache-2.0
