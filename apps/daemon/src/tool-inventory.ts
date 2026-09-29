import { maximumToolInventoryBytes, toolInventorySchema, type ToolInventory } from "@getdomovoi/protocol"

import { redactInventoryPath } from "./inventory-redaction.js"
import { readRepositoryProviderConfig, type RepositoryProviderConfig, type RepositoryProviderConfigOptions } from "./repository-provider-config.js"
import { projectRootRead, repositoryTrustState } from "./repository-trust-apply.js"
import type { RepositoryTrustGrant } from "./repository-trust-store.js"

// The tool.inventory answer: what the open repository's own agent
// configuration declares, read by repository-provider-config.ts, with the
// digest a trust decision pins to. Reading starts nothing.
//
// toolServers stays "read-from-files", as the reader reports it, for every
// provider: Domovoi starts none of them with tool servers stripped. Claude Code
// loads the person's own servers (settingSources ["user"], claude.ts), Codex
// its home's config.toml (no MCP override, codex.ts), and OpenCode and Kilo
// their global config (the embedded config sets no `mcp`, opencode.ts and
// kilo-runtime.ts). The ACP agents are given no servers, but they load their
// own from the repository and the reader has no scope for them.
//
// An entry is marked held back only where its adapter provably keeps it from
// the agent (ruling Q128 A); repository-trust-apply.ts owns that policy, and
// the trust decision beside it.
//
// Trust is this machine's grant for the repository (repository-trust-store.ts),
// reported against the digest read now. The root is read as its session
// worktrees read it (ruling Q145 A).

export type RepositoryProviderConfigReader = (rootPath: string, options: RepositoryProviderConfigOptions) => Promise<RepositoryProviderConfig>

export type ToolInventoryInput = {
  machine: ToolInventory["machine"]
  // The open project, if any: its id and the repository root it names.
  project: { id: string; path: string } | undefined
  // This machine's trust grant for the open project, if any.
  grant?: RepositoryTrustGrant | undefined
  read?: RepositoryProviderConfigReader
}

export async function readToolInventory({ machine, project, grant, read = readRepositoryProviderConfig }: ToolInventoryInput): Promise<ToolInventory> {
  // The reader reads repository files only, so with no project open there is
  // nothing to list.
  if (project === undefined) return checked({ machine, providers: [] })
  const config = await read(project.path, projectRootRead)
  return checked(fitToolInventory({
    machine,
    repository: {
      projectId: project.id,
      root: redactInventoryPath(project.path),
      configDigest: config.configDigest,
      trust: repositoryTrustState(config, grant),
    },
    providers: config.providers,
  }))
}

// Nothing is sent that the protocol refuses. The error names no path or value,
// and neither does a reader's (ruling Q123); the RPC answers either with the
// daemon's internal error.
function checked(inventory: ToolInventory): ToolInventory {
  const parsed = toolInventorySchema.safeParse(inventory)
  if (!parsed.success) throw new Error("The tool inventory does not fit the protocol")
  return parsed.data
}

const encoder = new TextEncoder()
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength

// The inventory within `maximum` serialized UTF-8 bytes: while it is over, the
// provider listing the most entry bytes leaves out its last entry and counts
// it in omittedEntries, so one large file does not crowd out every other
// provider. Entries keep the reader's order. The size is tracked exactly: an
// entry leaves with its separating comma, and a count can gain a digit.
export function fitToolInventory(inventory: ToolInventory, maximum: number = maximumToolInventoryBytes): ToolInventory {
  const providers = inventory.providers.map((provider) => ({ ...provider, entries: [...provider.entries] }))
  const fitted: ToolInventory = { ...inventory, providers }
  let size = bytesOf(fitted)
  if (size <= maximum) return fitted
  const entryBytes = providers.map((provider) => provider.entries.map(bytesOf))
  const listedBytes = entryBytes.map((sizes) => sizes.reduce((total, bytes) => total + bytes, 0))
  while (size > maximum) {
    let heaviest: number | undefined
    for (const [index, provider] of providers.entries()) {
      if (provider.entries.length > 0 && (heaviest === undefined || listedBytes[index]! > listedBytes[heaviest]!)) heaviest = index
    }
    // Nothing left to leave out: the schema check refuses what remains.
    if (heaviest === undefined) break
    const provider = providers[heaviest]!
    const dropped = entryBytes[heaviest]!.pop()!
    provider.entries.pop()
    listedBytes[heaviest]! -= dropped
    const digits = String(provider.omittedEntries).length
    provider.omittedEntries += 1
    size += String(provider.omittedEntries).length - digits - dropped - (provider.entries.length > 0 ? 1 : 0)
  }
  return fitted
}
