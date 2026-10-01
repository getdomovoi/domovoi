import {
  OpenCodeSdkAdapter,
  nextOpenCodeMessageId,
  type OpenCodeFactory,
} from "./opencode.js"
import { kiloBuiltInPermissions } from "./kilo-runtime.js"

export type KiloFactory = OpenCodeFactory

export const kiloLegacyRepositoryFiles = [".kilo/mcp.json", ".kilocode/mcp.json", ".kilocodemodes"] as const

export class KiloSdkAdapter extends OpenCodeSdkAdapter {
  constructor(factory: KiloFactory = defaultKiloFactory, id: (after?: string) => string = nextOpenCodeMessageId) {
    super(factory, id, {
      providerId: "kilo",
      providerName: "Kilo",
      heldBackRepositoryFiles: kiloLegacyRepositoryFiles,
      builtInPermissions: kiloBuiltInPermissions,
    })
  }
}

const defaultKiloFactory: KiloFactory = async () => {
  const { createDefaultKiloRuntime } = await import("./kilo-runtime.js")
  return createDefaultKiloRuntime()
}
