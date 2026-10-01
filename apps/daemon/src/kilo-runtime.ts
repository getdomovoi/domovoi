import type { Config } from "@kilocode/sdk"

import { createAuthenticatedEmbeddedRuntime } from "./embedded-server.js"
import {
  askBeforeEdits,
  builtInSubagents,
  defaultReads,
  domovoiAskAgent,
  domovoiPermission,
  domovoiPlanLimits,
  openCodeBuiltInPermissions,
  openCodeBuiltInToolIds,
  openCodeDefaultAllows,
  openCodeDefaultDenies,
  permissionActions,
  planSubagents,
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
// Only the tools Kilo's defaults allow whatever the client and config. Kilo
// asks for its notebook tools as the VS Code client with
// experimental.native_notebook_tools on, and for browser_open as the VS Code
// client (kilocode/agent/index.ts prepare), so those four are not restated:
// the catch-all asks for them everywhere (security review round 1 of #687).
export const kiloConditionalAsks = ["notebook_read", "notebook_edit", "notebook_execute", "browser_open"] as const
export const kiloDefaultAllows = [
  ...openCodeDefaultAllows,
  "semantic_search",
  "open_plan",
  "agent_manager",
  "board_read",
  "board_post",
  "goal",
  "goal_report",
  "sandbox_escalation",
  "write",
] as const
export const kiloDefaultDenies = [...openCodeDefaultDenies, "suggest", "repo_clone", "repo_overview"] as const

// Every permission Kilo's own tools ask under.
export const kiloBuiltInPermissions: ReadonlySet<string> = new Set([
  ...openCodeBuiltInPermissions,
  ...kiloDefaultAllows,
  ...kiloDefaultDenies,
  ...kiloConditionalAsks,
  "recall",
  "kilo_memory_recall",
  "kilo_memory_save",
])

// The tools Kilo registers itself under Domovoi's embedded server, as its tool
// ids list them (`kilo serve` 7.8.1, /experimental/tool/ids).
export const kiloBuiltInToolIds: readonly string[] = [
  ...openCodeBuiltInToolIds,
  "plan_exit", "suggest", "goal_report", "goal", "board_read", "board_post", "kilo_memory_recall", "kilo_memory_save",
  "kilo_local_recall", "background_process", "schedule_wakeup", "cancel_wakeup", "cron_create", "cron_list", "cron_delete",
  "agent_manager_models", "notify_user", "send_file", "link_pr",
]

// The top-level block, which every agent block below starts with as well, so
// a person's own "*" rule for an agent cannot open what it closes.
const kiloPermission = domovoiPermission(kiloDefaultAllows, kiloDefaultDenies)
const kiloCode = { ...kiloPermission, question: "allow", suggest: "allow", plan_enter: "allow", task: builtInSubagents, todowrite: "allow" } as const

// Kilo's plan and explore agents deny every tool they do not name before the
// person's rules. Their blocks start with the catch-all, which asks, then
// restate what each allows and deny every other built-in tool by name, so
// only a tool that is not Kilo's own moves, from deny to ask.
const deniedBuiltIns = (allowed: ReadonlySet<string>) => permissionActions(
  [...kiloBuiltInPermissions].filter((name) => !allowed.has(name)),
  "deny",
)
const kiloPlanAllows: ReadonlySet<string> = new Set([
  "glob", "grep", "list", "question", "plan_exit", "suggest", "skill", "websearch", "semantic_search", "board_read", "board_post", "open_plan",
])
const kiloExploreAllows: ReadonlySet<string> = new Set(["glob", "grep", "list", "skill", "websearch", "semantic_search", "board_read", "board_post"])

export const domovoiKiloConfig: Config = {
  autoupdate: false,
  permission: kiloPermission,
  agent: ({
    "domovoi-ask": domovoiAskAgent,
    plan: {
      permission: {
        "*": "ask",
        ...deniedBuiltIns(new Set([...kiloPlanAllows, ...Object.keys(domovoiPlanLimits)])),
        read: defaultReads,
        ...permissionActions([...kiloPlanAllows], "allow"),
        task: planSubagents,
        ...domovoiPlanLimits,
      },
    },
    // Kilo reads a "build" block as its code agent's, and of two blocks for
    // one agent the later replaces the earlier, so both names carry the block
    // and a person's own block under either name cannot replace it.
    build: { permission: kiloCode },
    code: { permission: kiloCode },
    "domovoi-auto": {
      mode: "primary",
      description: "Domovoi automatic build mode",
      permission: { ...kiloPermission, task: builtInSubagents, todowrite: "allow" },
    },
    general: { permission: { ...kiloPermission, todowrite: "deny" } },
    explore: {
      permission: {
        "*": "ask",
        ...deniedBuiltIns(new Set([...kiloExploreAllows, ...Object.keys(askBeforeEdits)])),
        read: "allow",
        ...permissionActions([...kiloExploreAllows], "allow"),
        ...askBeforeEdits,
      },
    },
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
