# @getdomovoi/protocol

Typed schemas and shared types for the Domovoi daemon and clients.

## Installation

`@getdomovoi/protocol` is not yet on a package registry, so there is no version to install from
npm. The package itself is ready to be published: `pnpm test:packages` checks what the tarball
contains, and `pnpm test:install` installs that tarball into a scratch project outside the
workspace and imports it with npm, pnpm, and Bun, then type checks a consumer under the
`nodenext`, `bundler`, and `node10` module resolutions.

After the first release the install is the ordinary one:

```bash
npm install @getdomovoi/protocol
```

The package is ESM with bundled type declarations. Node 22 or newer is required. On Node versions
that support `require` of an ES module the package also loads from CommonJS.

## Workspace use

Other packages in this repository depend on it with `workspace:*` and consume the build output.

```bash
pnpm install
pnpm --filter @getdomovoi/protocol build
```

## Usage

```ts
import { protocolVersion, rpcRequestSchema, workspaceSnapshotSchema } from "@getdomovoi/protocol"

const request = rpcRequestSchema.parse(input)
const snapshot = workspaceSnapshotSchema.parse(response)

console.log(protocolVersion, request, snapshot)
```

The package exports the versioned JSON-RPC schemas, workspace and session types, preview bridge
messages, and test fixtures used by Domovoi implementations.

String maxima and exact lengths use UTF-16 code units, matching JavaScript `String.length`
and the daemon/client prechecks. Schemas use `utf16MaxLength` and `utf16Length` explicitly;
Zod 4.5's default string bounds count Unicode code points instead. Array and numeric bounds
retain their existing units and limits.

Timestamp fields retain the previously accepted seconds-or-minutes grammar. `dateTimeSchema`
requires UTC (`Z`); `offsetDateTimeSchema` also accepts numeric offsets. Both validate calendar
dates and times and reject local datetimes. Minute-only values such as `2026-09-07T12:30Z`
remain unchanged on read, including in persisted state and hashed transfer manifests. Adding
seconds on load would change a manifest's digest. Writers continue using `toISOString()`.

## Relay codec

The separate `@getdomovoi/protocol/relay` entry exports `createNoiseIk` and
`relayNoiseSuite`: the frozen suite-A Noise IK composition. External review is
pending. It does not enable relay networking or implement device admission,
key generation or storage. The Node comparison oracle and public vectors are
test-only and are excluded from the package. Read the
[wire contract and integration limits](https://github.com/getdomovoi/domovoi/blob/main/docs/relay-wire-format.md)
before integrating it.

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

### Runtime discovery for a new session

An authenticated phone uses `client: "phone"` (a tablet uses `"tablet"`). On the
**execution machine's socket**, call:

```json
{"jsonrpc":"2.0","id":1,"method":"runtime.discover","params":{"provider":"codex","client":"phone"}}
```

The provider id comes from `snapshot.machine.providers[].id`. Discovery is scoped to
that machine and provider, independent of the currently open project. There is no
cross-machine fallback, global preferred provider, or project-specific model catalog.
The caller selects the provider. A project does not have to be open to discover runtimes.

A successful response has this shape. Model names below are illustrative; pass through
the actual values returned by the daemon:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "machineId": "machine-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "provider": "codex",
    "status": "ready",
    "models": [{
      "provider": "codex",
      "id": "provider-model-id",
      "displayName": "Provider model name",
      "description": "Provider model description",
      "supportedReasoningEfforts": ["low", "high"],
      "defaultReasoningEffort": "high",
      "isDefault": true
    }],
    "defaultRuntime": {
      "provider": "codex",
      "model": "provider-model-id",
      "reasoning": "high",
      "permissionMode": "ask",
      "auto": false
    },
    "permissionModes": ["ask", "plan", "build"],
    "supportsAuto": false
  }
}
```

- Accepting the default means passing `result.defaultRuntime` unchanged as `runtime`
  to `session.create`, alongside `title` and `client: "phone"`. A valid Git project
  must first be open through `project.open`. `session.create` still returns a workspace
  snapshot, with the created session selected by `activeSessionId`.
- For a model picker, use `models[].displayName` as the label and `models[].id` as
  `runtime.model`. On selection, use that model's `defaultReasoningEffort`. Offer its
  `supportedReasoningEfforts` as choices; an empty array means keep the returned
  default and show no reasoning selector. These values are opaque provider strings.
- The daemon picks the first provider-marked default model, or the first returned
  model if none is marked. It uses that model's default reasoning. Auto is always off.
  The default permission mode is Ask when the adapter enforces read-only Ask, otherwise
  Plan. Offer only `permissionModes`; `supportsAuto` permits Auto only in Build.
- Readiness is probed on each discovery, including when models came from the daemon's
  successful catalog cache (up to 60 seconds). Concurrent discoveries for a provider
  share one request. Authentication loss invalidates its cached catalog. Creating or
  changing a runtime checks readiness again before using the model catalog.

An unavailable provider is a normal RPC result with **no** `models` or `defaultRuntime`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "machineId": "machine-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "provider": "codex",
    "status": "unavailable",
    "reason": "auth-required",
    "action": "sign-in",
    "retryable": false,
    "message": "Sign in to this provider on the execution machine, then retry discovery."
  }
}
```

| `reason` | `action` | `retryable` | Client behavior |
| --- | --- | --- | --- |
| `auth-required` | `sign-in` | false | Show sign-in instructions for the execution machine. |
| `missing` | `install` | false | Show installation instructions for the execution machine. |
| `readiness-unknown` | `retry` | true | Show that readiness could not be verified. |
| `unsupported` | `choose-provider` | false | Offer a different provider. |
| `timeout` | `retry` | true | Stop loading and offer Retry or a different provider. |
| `discovery-failed` | `retry` | true | Show the refusal and offer Retry. |
| `no-models` | `configure` | false | Ask the operator to configure model access on the execution machine. |

Render `message` and disable Create for all unavailable results. `retryable: false`
means an external action is needed first; the person can call discovery again after
that action. Never fabricate a runtime or keep offering a previous provider's choices.
Discard an old response if the selected machine or provider has changed while waiting.

`maximumRuntimeDiscoveryMs` is 10,000 ms for the entire daemon operation, including
readiness, connection setup and catalog retrieval. Keep a client-side deadline too
(15 seconds allows 5 seconds of transport margin); a lost socket cannot deliver a
daemon refusal. Discovery bypasses the mutation queue and remains available when
persistence fails. Timed-out catalogs are cancelled, can be retried, and cannot replace
a newer catalog when they answer late. Error messages contain fixed refusal copy,
not CLI output, account details or credentials.

`ready` reports the current authenticated local probe and provider catalog, not a
reservation of provider capacity. Discovery sends no model prompt and creates no
worktree or session. Authentication, quota or model access can change afterward, so
handle a `session.create` error by retaining the form and rediscovering. This contract
does not test a billable inference to prove quota availability.

This addition keeps protocol version `0.5.0`. `runtime.models` and the required full
`session.create.runtime` remain compatible. An older daemon may answer `runtime.discover`
with `-32601`; show an upgrade requirement. Desktop can adopt this same call for its
new-session form and permission controls; this change ships the protocol and daemon only.

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
