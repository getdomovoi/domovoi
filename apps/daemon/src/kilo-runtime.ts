import type { Config } from "@kilocode/sdk"

import { createAuthenticatedEmbeddedRuntime, embeddedServerCommand } from "./embedded-server.js"
import { domovoiAgentPermission, requireOpenCodeClient, type OpenCodeFactory } from "./opencode.js"

export const domovoiKiloConfig: Config = {
  autoupdate: false,
  permission: domovoiAgentPermission,
  agent: {
    "domovoi-ask": {
      mode: "primary",
      description: "Domovoi read-only ask mode",
      tools: {
        "*": false,
        read: true,
        glob: true,
        grep: true,
        list: true,
        webfetch: true,
        websearch: true,
        question: true,
      },
      permission: {
        edit: "deny",
        bash: "deny",
        webfetch: "allow",
        external_directory: "deny",
      },
    },
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
  const { createKiloClient } = await import(sdkPackage)
  const runtime = await createAuthenticatedEmbeddedRuntime({
    passwordEnvironment: "KILO_SERVER_PASSWORD",
    usernameEnvironment: "KILO_SERVER_USERNAME",
    username: "kilo",
    // What the SDK's createKiloServer passes, plus the project switch. The SDK
    // also merges a KILO_CONFIG_CONTENT the daemon itself inherited (from a
    // Kilo terminal, say); this replaces it, so only Domovoi's rules load.
    environment: {
      KILO_DISABLE_PROJECT_CONFIG: "1",
      KILO_CONFIG_CONTENT: JSON.stringify(domovoiKiloConfig),
    },
    startServer: embeddedServerCommand("kilo", "kilo server listening"),
    createClient: createKiloClient,
  })
  return {
    client: requireOpenCodeClient(runtime.client, "Kilo"),
    server: runtime.server,
  }
}
