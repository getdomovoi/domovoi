import { describe, expect, it } from "vitest"

import { domovoiKiloConfig } from "./kilo-runtime.js"
import { domovoiOpenCodeConfig } from "./opencode.js"

// Ruling Q155 A: OpenCode and Kilo ask before every tool that is not one of
// their own, so a tool server's call gets an approval card. Ruling Q229 A:
// every built-in tool keeps the action it had before.
//
// The servers merge rules and pick the last one that matches, so the order of
// the layers decides. This file ports, as plain data, how each server builds
// an agent's rules from its defaults, its own agent block, the person's merged
// `permission` (where the embedded config's top-level block lands) and the
// embedded config's agent blocks. Ported from anomalyco/opencode v1.18.32
// (packages/opencode/src/permission/index.ts evaluate/fromConfig,
// agent/agent.ts, agent/subagent-permissions.ts, packages/core/src/util/
// wildcard.ts, packages/core/src/v1/config/agent.ts normalize) and
// Kilo-Org/kilocode v7.8.1 (the same files plus kilocode/agent/index.ts
// patchAgents, hardenPlan, hardenExplore). Paths and Kilo's bash allowlists
// are placeholders: they are the same before and after. The port was checked
// against `opencode serve` and `kilo serve` at those versions, whose /agent
// answers give the same actions.

type Action = "allow" | "ask" | "deny"
type Rule = { permission: string; pattern: string; action: Action }
type Block = Record<string, Action | Record<string, Action>>
type AgentConfig = { permission?: Block; tools?: Record<string, boolean> }
type EmbeddedConfig = { permission?: Block; agent?: Record<string, AgentConfig | undefined> }

function match(input: string, pattern: string): boolean {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, "su").test(input)
}

const rules = (block: Block = {}): Rule[] => Object.entries(block).flatMap(([permission, value]) => (
  typeof value === "string"
    ? [{ permission, pattern: "*", action: value }]
    : Object.entries(value).map(([pattern, action]) => ({ permission, pattern, action }))
))

const evaluate = (permission: string, pattern: string, ruleset: readonly Rule[]): Action => (
  ruleset.findLast((rule) => match(permission, rule.permission) && match(pattern, rule.pattern))?.action ?? "ask"
)

// An agent block as the config schema decodes it: legacy `tools` first, as
// allow or deny, then the block's own permission keys.
function agentBlock(agent: AgentConfig | undefined): Rule[] {
  const block: Block = {}
  for (const [tool, enabled] of Object.entries(agent?.tools ?? {})) {
    block[tool === "write" || tool === "patch" ? "edit" : tool] = enabled ? "allow" : "deny"
  }
  Object.assign(block, agent?.permission ?? {})
  return rules(block)
}

const denies = (ruleset: readonly Rule[]) => ruleset.filter((rule) => rule.action === "deny")
const envReads: Record<string, Action> = { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" }

// A task-tool subagent's session adds its parent's denies and, unless the
// subagent's own rules name them, denies of todowrite and task.
function subagentSession(parent: readonly Rule[], subagent: readonly Rule[]): Rule[] {
  return [
    ...parent.filter((rule) => rule.permission === "external_directory" || rule.action === "deny"),
    ...(subagent.some((rule) => rule.permission === "todowrite") ? [] : [{ permission: "todowrite", pattern: "*", action: "deny" as const }]),
    ...(subagent.some((rule) => rule.permission === "task") ? [] : [{ permission: "task", pattern: "*", action: "deny" as const }]),
  ]
}

function openCodeAgents(config: EmbeddedConfig): Record<string, Rule[]> {
  const defaults = rules({
    "*": "allow", doom_loop: "ask", external_directory: { "*": "ask", "/tool-output/*": "allow" },
    question: "deny", plan_enter: "deny", plan_exit: "deny", read: envReads,
  })
  const user = rules(config.permission)
  const builtIn: Record<string, Rule[]> = {
    build: [...defaults, ...rules({ question: "allow", plan_enter: "allow" }), ...user],
    plan: [...defaults, ...rules({
      question: "allow", plan_exit: "allow", task: { general: "deny" }, external_directory: { "/data/plans/*": "allow" },
      edit: { "*": "deny", ".opencode/plans/*.md": "allow" },
    }), ...user],
    general: [...defaults, ...rules({ todowrite: "deny" }), ...user],
    explore: [...defaults, ...rules({
      "*": "deny", grep: "allow", glob: "allow", list: "allow", bash: "allow", webfetch: "allow", websearch: "allow", read: "allow",
      external_directory: { "*": "ask", "/tool-output/*": "allow" },
    }), ...user],
    compaction: [...defaults, ...rules({ "*": "deny" }), ...user],
    title: [...defaults, ...rules({ "*": "deny" }), ...user],
    summary: [...defaults, ...rules({ "*": "deny" }), ...user],
  }
  for (const [name, agent] of Object.entries(config.agent ?? {})) {
    builtIn[name] = [...(builtIn[name] ?? [...defaults, ...user]), ...agentBlock(agent)]
  }
  return builtIn
}

function kiloAgents(config: EmbeddedConfig, ownServers: readonly string[]): Record<string, Rule[]> {
  const bash: Record<string, Action> = { "*": "ask", "ls *": "allow", "*|*": "deny" }
  const readOnlyBash: Record<string, Action> = { ...bash, "*": "deny" }
  const exploreBash: Record<string, Action> = { ...readOnlyBash, "gh *": "deny" }
  const mcp = Object.fromEntries(ownServers.map((name) => [`${name.replace(/[^a-zA-Z0-9_-]/gu, "_")}_*`, "ask" as const]))
  const defaults = [
    ...rules({
      "*": "allow", doom_loop: "ask", external_directory: { "*": "ask", "/tool-output/*": "allow" },
      suggest: "deny", question: "deny", plan_enter: "deny", plan_exit: "deny", repo_clone: "deny", repo_overview: "deny", read: envReads,
    }),
    ...rules({ bash, board_read: "allow", board_post: "allow", recall: "ask", kilo_memory_recall: "ask", kilo_memory_save: "ask" }),
  ]
  const user = rules(config.permission)
  const guarded = ["bash", "task", "notebook_edit", "notebook_execute", "write", "agent_manager", "repo_clone"]
  const sealed = guarded.filter((permission) => permission !== "task")
  const guardedDenies = Object.fromEntries(guarded.filter((permission) => permission !== "bash" && permission !== "task").map((permission) => [permission, "deny" as const]))
  const planEdit = rules({ edit: { "*": "deny", ".kilo/plans/*.md": "allow", "plans/*.md": "allow", ".plans/*.md": "allow", ".opencode/plans/*.md": "allow" } })
  const planGuard = rules({
    "*": "deny", question: "allow", suggest: "allow", skill: "allow", plan_exit: "allow", open_plan: "allow",
    task: { "*": "allow", general: "deny" }, bash: readOnlyBash, read: envReads, grep: "allow", glob: "allow", list: "allow",
    webfetch: "allow", websearch: "allow", semantic_search: "allow",
    external_directory: { "/tool-output/*": "allow", "/data/plans/*": "allow" },
    edit: { "*": "deny", ".kilo/plans/*.md": "allow", "plans/*.md": "allow", ".plans/*.md": "allow", ".opencode/plans/*.md": "allow" },
    ...mcp, board_read: "allow", board_post: "allow", ...guardedDenies,
  })
  const editRestrictions = (ruleset: readonly Rule[]) => {
    const edit = ruleset.filter((rule) => rule.permission === "edit")
    return edit.filter((rule, index) => rule.action === "deny" && (rule.pattern !== "*" || !edit.slice(index + 1).some((next) => next.action !== "deny")))
  }
  const restrictions = (ruleset: readonly Rule[]) => [...ruleset.filter((rule) => rule.action === "deny" && rule.permission !== "edit"), ...editRestrictions(ruleset)]
  const baseline = (guard: readonly Rule[]) => {
    const known = new Set(guard.map((rule) => rule.permission).filter((permission) => permission !== "*" && !Object.hasOwn(mcp, permission) && !sealed.includes(permission)))
    return [
      ...guard.filter((rule) => rule.permission === "*" || known.has(rule.permission)),
      ...user.flatMap((rule) => [...known].filter((permission) => match(permission, rule.permission)).map((permission) => ({ ...rule, permission }))),
      ...guard.filter((rule) => rule.permission === "bash" || Object.hasOwn(mcp, rule.permission)
        || (rule.action === "deny" && guarded.includes(rule.permission)
          && (rule.pattern === "*" || !user.some((item) => item.permission === rule.permission && item.pattern === rule.pattern)))),
    ]
  }
  const build = [...defaults, ...rules({ question: "allow", suggest: "allow", plan_enter: "allow" }), ...user]
  const agents: Record<string, Rule[]> = {
    code: [...defaults, ...build, ...user, ...rules({ semantic_search: "allow" })],
    plan: [...defaults, ...planGuard, ...user, ...baseline(planGuard), ...planEdit, ...restrictions(user)],
    general: [...defaults, ...rules({ todowrite: "deny" }), ...user],
    explore: [...defaults, ...rules({
      "*": "deny", grep: "allow", glob: "allow", list: "allow", skill: "allow", webfetch: "allow", websearch: "allow",
      semantic_search: "allow", read: "allow", board_read: "allow", board_post: "allow",
      external_directory: { "*": "ask", "/tool-output/*": "allow" },
    }), ...user, ...rules({ bash: exploreBash }), ...denies(user)],
  }
  for (const [configured, agent] of Object.entries(config.agent ?? {})) {
    const name = configured === "build" ? "code" : configured
    const block = agentBlock(agent)
    let ruleset = [...(agents[name] ?? [...defaults, ...user]), ...block]
    if (name === "plan") ruleset = [...ruleset, ...planEdit, ...editRestrictions(user), ...editRestrictions(block)]
    if (name === "explore") ruleset = [...ruleset, ...rules({ bash: exploreBash }), ...denies(user), ...denies(block)]
    agents[name] = ruleset
  }
  return agents
}

// The embedded configs as they were before ruling Q155 A, kept to compare.
const askAll = { edit: "ask", bash: "ask", webfetch: "ask", doom_loop: "ask", external_directory: "ask" } as const
const before: EmbeddedConfig = {
  permission: askAll,
  agent: {
    "domovoi-ask": {
      tools: { "*": false, read: true, glob: true, grep: true, list: true, webfetch: true, websearch: true, question: true },
      permission: { edit: "deny", bash: "deny", webfetch: "allow", external_directory: "deny" },
    },
    plan: { permission: { edit: "deny", bash: "deny", webfetch: "allow", external_directory: "deny" } },
    build: { permission: askAll },
    "domovoi-auto": { permission: askAll },
  },
}

const openCodeBuiltIns = [
  "read", "edit", "glob", "grep", "list", "lsp", "bash", "task", "todowrite", "question", "plan_enter", "plan_exit",
  "webfetch", "websearch", "skill", "doom_loop", "external_directory",
]
const kiloBuiltIns = [
  ...openCodeBuiltIns, "suggest", "open_plan", "semantic_search", "agent_manager", "recall", "repo_overview", "repo_clone",
  "notebook_read", "notebook_edit", "notebook_execute", "browser_open", "board_read", "board_post", "goal", "goal_report",
  "sandbox_escalation", "write", "kilo_memory_recall", "kilo_memory_save",
]
const patterns: Record<string, string[]> = {
  read: ["src/a.ts", "/w/.env", "/w/.env.example", "mcp:docs:readme"],
  edit: ["src/a.ts", ".opencode/plans/p.md", ".kilo/plans/p.md"],
  bash: ["ls -la", "rm -rf build", "ls | sh"],
  task: ["general", "explore"],
  external_directory: ["/tool-output/x", "/data/plans/x", "/etc/hosts"],
}
const patternsOf = (permission: string) => patterns[permission] ?? ["*"]
// A person's own tool server, one the repository could add, and a plugin tool.
const ownServer = "docs"
const otherTools = ["docs_search", "github_create_issue", "customtool"]

const cases = [
  ["OpenCode", openCodeBuiltIns, openCodeAgents(before), openCodeAgents(domovoiOpenCodeConfig as EmbeddedConfig), "build"],
  ["Kilo", kiloBuiltIns, kiloAgents(before, [ownServer]), kiloAgents(domovoiKiloConfig as EmbeddedConfig, [ownServer]), "code"],
] as const

describe.each(cases)("%s permissions under the embedded config", (name, builtIns, old, now, primary) => {
  // The rules a call is judged by in each agent a Domovoi session runs: its
  // four primary agents and OpenCode's own compaction, title and summary
  // agents by their own rules, and the subagents the task tool starts from the
  // primary agent with their session's rules added. Kilo's ask, debug and
  // orchestrator agents are primary, so no Domovoi session reaches them, and
  // Kilo denies everything to its own compaction, title and summary agents
  // whatever the config says.
  const subagents = ["general", "explore"]
  const judged = (agents: Record<string, Rule[]>) => Object.fromEntries(Object.entries(agents).map(([agent, ruleset]) => [
    agent,
    subagents.includes(agent) ? [...ruleset, ...subagentSession(agents[primary]!, ruleset)] : ruleset,
  ]))
  const was = judged(old)
  const is = judged(now)

  it("keeps every built-in tool's action for every agent a session runs", () => {
    expect(Object.keys(is)).toEqual(Object.keys(was))
    for (const agent of Object.keys(was)) {
      for (const permission of builtIns) {
        for (const pattern of patternsOf(permission)) {
          expect(`${agent} ${permission} ${pattern}: ${evaluate(permission, pattern, is[agent]!)}`)
            .toBe(`${agent} ${permission} ${pattern}: ${evaluate(permission, pattern, was[agent]!)}`)
        }
      }
    }
  })

  // Kilo re-applies every deny an explore block names after the block, so its
  // catch-all deny cannot be restated there: a tool server's tool, hidden from
  // Kilo's explore subagent before, now asks there.
  it("asks before a tool server's or plugin's tool that used to run without asking", () => {
    for (const agent of Object.keys(was)) {
      for (const tool of otherTools) {
        const before = evaluate(tool, "*", was[agent]!)
        const expected = before === "allow" || (name === "Kilo" && agent === "explore") ? "ask" : before
        expect(`${agent} ${tool}: ${evaluate(tool, "*", is[agent]!)}`).toBe(`${agent} ${tool}: ${expected}`)
      }
    }
    expect(evaluate("github_create_issue", "*", is[primary]!)).toBe("ask")
    expect(evaluate("docs_search", "*", is.plan!)).toBe("ask")
  })
})

describe("the embedded config's own shape", () => {
  it.each([
    ["OpenCode", domovoiOpenCodeConfig],
    ["Kilo", domovoiKiloConfig],
  ] as const)("puts %s's catch-all first, so every rule after it still applies", (_name, config) => {
    const permission = config.permission as Record<string, unknown> | undefined
    expect(Object.entries(permission ?? {})[0]).toEqual(["*", "ask"])
  })
})
