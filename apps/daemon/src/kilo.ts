import {
  OpenCodeSdkAdapter,
  nextOpenCodeMessageId,
  type OpenCodeFactory,
} from "./opencode.js"

export type KiloFactory = OpenCodeFactory

export class KiloSdkAdapter extends OpenCodeSdkAdapter {
  constructor(factory: KiloFactory = defaultKiloFactory, id: (after?: string) => string = nextOpenCodeMessageId) {
    super(factory, id, { providerId: "kilo", providerName: "Kilo" })
  }
}

const defaultKiloFactory: KiloFactory = async () => {
  const { createDefaultKiloRuntime } = await import("./kilo-runtime.js")
  return createDefaultKiloRuntime()
}
