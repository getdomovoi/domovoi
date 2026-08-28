import type { Config } from "@kilocode/sdk"

import type { OpenCodeClient, OpenCodeFactory } from "./opencode.js"

const domovoiKiloConfig: Config = {
  autoupdate: false,
  agent: {
    plan: {
      permission: {
        edit: "deny",
        bash: "deny",
        webfetch: "allow",
        external_directory: "deny",
      },
    },
    build: {
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "ask",
        external_directory: "ask",
      },
    },
    "domovoi-auto": {
      mode: "primary",
      description: "Domovoi automatic build mode",
      permission: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        external_directory: "allow",
      },
    },
  },
}

export const createDefaultKiloRuntime: OpenCodeFactory = async () => {
  const sdkPackage = "@kilocode/sdk"
  const { createKilo } = await import(sdkPackage)
  const runtime = await createKilo({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 10_000,
    config: domovoiKiloConfig,
  })
  return {
    client: runtime.client as unknown as OpenCodeClient,
    server: runtime.server,
  }
}
