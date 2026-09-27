import { homedir } from "node:os"
import { join } from "node:path"

import { AcpAgentAdapter, type AcpPeer, type AcpPeerHandlers } from "./acp.js"
import {
  CURSOR_ACP_PROVIDER,
  GROK_ACP_PROVIDER,
  parseAcpModelCatalog,
  type AcpProviderDefinition,
} from "./acp-providers.js"
import { StdioAcpPeer } from "./acp-stdio.js"
import { profileDirectory } from "./profile-directory.js"
import { runProviderCommand, type ProviderCommandRunner } from "./providers.js"

type PeerFactory = (handlers: AcpPeerHandlers) => AcpPeer

type FactoryOptions = {
  run?: ProviderCommandRunner
  createPeer?: PeerFactory
  // Where each agent process gets its own empty launch folder: the daemon's
  // profile, never the temporary folder, whose location a repository can share.
  launchRoot?: string
}

export function createCursorAgentAdapter(options: FactoryOptions = {}): AcpAgentAdapter {
  return createAdapter(CURSOR_ACP_PROVIDER, options)
}

export function createGrokAgentAdapter(options: FactoryOptions = {}): AcpAgentAdapter {
  return createAdapter(GROK_ACP_PROVIDER, options)
}

function createAdapter(
  definition: AcpProviderDefinition,
  options: FactoryOptions,
): AcpAgentAdapter {
  const { displayName } = definition
  const run = options.run ?? runProviderCommand
  const launchRoot = options.launchRoot ?? join(profileDirectory(homedir()), "acp")
  const createPeer = options.createPeer ?? ((handlers) => new StdioAcpPeer({ definition, handlers, launchRoot }))
  return new AcpAgentAdapter({
    definition,
    createPeer,
    listModels: async (signal) => {
      for (const command of definition.commands) {
        try {
          signal?.throwIfAborted()
          const result = await run(command, [...definition.modelArgs], signal)
          if (result.exitCode !== 0) throw new Error(`${displayName} model catalog is unavailable`)
          return parseAcpModelCatalog(definition.id, result.stdout)
        } catch (error) {
          if (isMissingCommand(error)) continue
          throw new Error(`${displayName} model catalog is unavailable`, { cause: error })
        }
      }
      throw new Error(`${displayName} CLI is unavailable`)
    },
  })
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
