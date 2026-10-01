import type { Config } from "@kilocode/sdk"

import { createAuthenticatedEmbeddedRuntime } from "./embedded-server.js"
import {
  askBeforeEdits,
  domovoiAskAgent,
  domovoiPermission,
  domovoiPlanLimits,
  openCodeDefaultAllows,
  openCodeDefaultDenies,
  permissionActions,
  requireOpenCodeClient,
  type EmbeddedAgents,
  type OpenCodeFactory,
} from "./opencode.js"

// Kilo builds agents the way OpenCode does (domovoiOpenCodeConfig in
// opencode.ts explains the order and the catch-all), with more built-in tools
// and its own changes, read from Kilo-Org/kilocode v7.8.1 agent/agent.ts and
// kilocode/agent/index.ts and checked against `kilo serve`'s /agent answer:
// its defaults also deny suggest, repo_clone and repo_overview; its build
// agent is named code; and it appends every deny its explore block names
// after that block, so a catch-all deny cannot be restated there.
export const kiloDefaultAllows = [
  ...openCodeDefaultAllows,
  "semantic_search",
  "open_plan",
  "agent_manager",
  "notebook_read",
  "notebook_edit",
  "notebook_execute",
  "browser_open",
  "board_read",
  "board_post",
  "goal",
  "goal_report",
  "sandbox_escalation",
  "write",
] as const
export const kiloDefaultDenies = [...openCodeDefaultDenies, "suggest", "repo_clone", "repo_overview"] as const

// What Kilo's explore subagent may use before the person's rules; every other
// tool the catch-all would open is denied again by name.
const kiloExploreAllows: ReadonlySet<string> = new Set(["glob", "grep", "list", "skill", "websearch", "semantic_search", "board_read", "board_post"])
const kiloExploreDenies = [
  ...kiloDefaultAllows.filter((name) => !kiloExploreAllows.has(name)),
  "recall",
  "kilo_memory_recall",
  "kilo_memory_save",
]

export const domovoiKiloConfig: Config = {
  autoupdate: false,
  permission: domovoiPermission(kiloDefaultAllows, kiloDefaultDenies),
  agent: ({
    "domovoi-ask": domovoiAskAgent,
    plan: {
      permission: {
        question: "allow",
        plan_exit: "allow",
        suggest: "allow",
        task: { "*": "allow", general: "deny" },
        todowrite: "deny",
        ...domovoiPlanLimits,
      },
    },
    build: {
      permission: { question: "allow", suggest: "allow", plan_enter: "allow", task: "allow", todowrite: "allow", ...askBeforeEdits },
    },
    "domovoi-auto": {
      mode: "primary",
      description: "Domovoi automatic build mode",
      permission: { task: "allow", todowrite: "allow", ...askBeforeEdits },
    },
    general: { permission: { todowrite: "deny" } },
    explore: { permission: { read: "allow", ...permissionActions(kiloExploreDenies, "deny") } },
  } satisfies EmbeddedAgents) as NonNullable<Config["agent"]>,
}

export const createDefaultKiloRuntime: OpenCodeFactory = async () => {
  const sdkPackage = "@kilocode/sdk"
  const { createKiloClient, createKiloServer } = await import(sdkPackage)
  const runtime = await createAuthenticatedEmbeddedRuntime({
    passwordEnvironment: "KILO_SERVER_PASSWORD",
    usernameEnvironment: "KILO_SERVER_USERNAME",
    username: "kilo",
    environment: { KILO_DISABLE_PROJECT_CONFIG: "1" },
    config: domovoiKiloConfig,
    startServer: createKiloServer,
    createClient: createKiloClient,
  })
  return {
    client: requireOpenCodeClient(runtime.client, "Kilo"),
    server: runtime.server,
  }
}
