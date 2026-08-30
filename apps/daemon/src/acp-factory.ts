import { AcpAgentAdapter, type AcpPeer, type AcpPeerHandlers } from "./acp.js"
import {
  CURSOR_ACP_PROVIDER,
  GROK_ACP_PROVIDER,
  parseAcpModelCatalog,
  type AcpProviderDefinition,
} from "./acp-providers.js"
import { StdioAcpPeer } from "./acp-stdio.js"
import { runProviderCommand, type ProviderCommandRunner } from "./providers.js"

type PeerFactory = (handlers: AcpPeerHandlers) => AcpPeer

type FactoryOptions = {
  run?: ProviderCommandRunner
  createPeer?: PeerFactory
}

export function createCursorAgentAdapter(options: FactoryOptions = {}): AcpAgentAdapter {
  return createAdapter(CURSOR_ACP_PROVIDER, "Cursor", options)
}

export function createGrokAgentAdapter(options: FactoryOptions = {}): AcpAgentAdapter {
  return createAdapter(GROK_ACP_PROVIDER, "Grok", options)
}

function createAdapter(
  definition: AcpProviderDefinition,
  displayName: string,
  options: FactoryOptions,
): AcpAgentAdapter {
  const run = options.run ?? runProviderCommand
  const createPeer = options.createPeer ?? ((handlers) => new StdioAcpPeer({ definition, handlers }))
  return new AcpAgentAdapter({
    definition,
    createPeer,
    listModels: async () => {
      for (const command of definition.commands) {
        try {
          const result = await run(command, [...definition.modelArgs])
          if (result.exitCode !== 0) throw new Error(`${displayName} model catalog is unavailable`)
          return parseAcpModelCatalog(definition.id, result.stdout)
        } catch (error) {
          if (isMissingCommand(error)) continue
          throw new Error(`${displayName} model catalog is unavailable`)
        }
      }
      throw new Error(`${displayName} CLI is unavailable`)
    },
  })
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
