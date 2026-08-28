import { randomUUID } from "node:crypto"

import {
  OpenCodeSdkAdapter,
  type OpenCodeFactory,
} from "./opencode.js"

export type KiloFactory = OpenCodeFactory

export class KiloSdkAdapter extends OpenCodeSdkAdapter {
  constructor(factory: KiloFactory = defaultKiloFactory, id: () => string = randomUUID) {
    super(factory, id, { providerId: "kilo", providerName: "Kilo" })
  }
}

const defaultKiloFactory: KiloFactory = async () => {
  const { createDefaultKiloRuntime } = await import("./kilo-runtime.js")
  return createDefaultKiloRuntime()
}
