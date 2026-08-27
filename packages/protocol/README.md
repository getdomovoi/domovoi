# @getdomovoi/protocol

Typed schemas and shared types for the Domovoi daemon and clients.

## Install

```bash
pnpm add @getdomovoi/protocol
```

The package is standard ESM and can also be installed with npm or Bun.

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
