import type { Config } from "@kilocode/sdk"

import { createAuthenticatedEmbeddedRuntime } from "./embedded-server.js"
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
  const { createKiloClient, createKiloServer } = await import(sdkPackage)
  const runtime = await createAuthenticatedEmbeddedRuntime({
    passwordEnvironment: "KILO_SERVER_PASSWORD",
    usernameEnvironment: "KILO_SERVER_USERNAME",
    username: "kilo",
    config: domovoiKiloConfig,
    startServer: createKiloServer,
    createClient: createKiloClient,
  })
  return {
    client: runtime.client as unknown as OpenCodeClient,
    server: runtime.server,
  }
}
