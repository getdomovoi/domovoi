import type { Config } from "@kilocode/sdk"

import { createAuthenticatedEmbeddedRuntime } from "./embedded-server.js"
import { requireOpenCodeClient, type OpenCodeFactory } from "./opencode.js"

export const domovoiKiloConfig: Config = {
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
        doom_loop: "ask",
        external_directory: "ask",
      },
    },
    "domovoi-auto": {
      mode: "primary",
      description: "Domovoi automatic build mode",
      permission: {
        edit: "ask",
        bash: "ask",
        webfetch: "ask",
        doom_loop: "ask",
        external_directory: "ask",
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
    client: requireOpenCodeClient(runtime.client, "Kilo"),
    server: runtime.server,
  }
}
