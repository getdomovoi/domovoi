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

## License

Apache-2.0
