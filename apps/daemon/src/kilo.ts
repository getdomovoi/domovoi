import {
  OpenCodeSdkAdapter,
  allowedPermissionNames,
  nextOpenCodeMessageId,
  type OpenCodeFactory,
} from "./opencode.js"
import { domovoiKiloConfig, kiloBuiltInPermissions, kiloBuiltInToolIds } from "./kilo-runtime.js"

const kiloAllowedPermissions = allowedPermissionNames(domovoiKiloConfig)

export type KiloFactory = OpenCodeFactory

export const kiloLegacyRepositoryFiles = [".kilo/mcp.json", ".kilocode/mcp.json", ".kilocodemodes"] as const

export class KiloSdkAdapter extends OpenCodeSdkAdapter {
  constructor(factory: KiloFactory = defaultKiloFactory, id: (after?: string) => string = nextOpenCodeMessageId) {
    super(factory, id, {
      providerId: "kilo",
      providerName: "Kilo",
      heldBackRepositoryFiles: kiloLegacyRepositoryFiles,
      builtInPermissions: kiloBuiltInPermissions,
      builtInToolIds: kiloBuiltInToolIds,
      allowedPermissions: kiloAllowedPermissions,
      // Kilo runs the build agent as code (kilocode/agent/index.ts resolveKey).
      agentName: (agent) => (agent === "build" ? "code" : agent),
    })
  }
}

const defaultKiloFactory: KiloFactory = async () => {
  const { createDefaultKiloRuntime } = await import("./kilo-runtime.js")
  return createDefaultKiloRuntime()
}
