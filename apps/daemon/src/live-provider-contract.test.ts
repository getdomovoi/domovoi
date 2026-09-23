import { execFileSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import type { Runtime } from "@getdomovoi/protocol"
import { afterAll, describe, expect, it } from "vitest"

import type { AgentAdapter, AgentEvent } from "./agents.js"
import { ClaudeAgentSdkAdapter } from "./claude.js"
import { CodexAppServerAdapter } from "./codex.js"
import { createAuthenticatedEmbeddedRuntime } from "./embedded-server.js"
import { KiloSdkAdapter } from "./kilo.js"
import { domovoiKiloConfig } from "./kilo-runtime.js"
import { OpenCodeSdkAdapter, domovoiOpenCodeConfig, requireOpenCodeClient, type OpenCodeFactory } from "./opencode.js"
import { removeScratchDirectories } from "./test-scratch.js"

// The adapter tests drive fakes that submit every tool call for approval, so
// they cannot see a call a real provider approves on its own. This suite runs
// the providers installed on this machine through the real adapters, against
// a local stand-in for each model API: the stand-in asks for one shell command
// and reports whether a planted token ever came back to it. No model is
// called and no account is used. Opt in with DOMOVOI_LIVE_PROVIDERS=1; it is
// not for hosted CI.

const live = process.env.DOMOVOI_LIVE_PROVIDERS === "1"
const plantedToken = "AKIALIVECONTRACT0000"
const scratchDirectories: string[] = []
const realHome = homedir()
afterAll(async () => removeScratchDirectories(scratchDirectories))

type Mock = { url: string; leaked: () => boolean; close: () => Promise<void> }
type Step = { command: string }

function onPath(binary: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((directory) => existsSync(join(directory, binary)))
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`)
  }))
}

// One tool call on the first request that offers tools, a plain reply after.
async function modelStandIn(kind: "anthropic" | "chat" | "responses", step: Step): Promise<Mock> {
  let leaked = false
  let asked = false
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => { body += chunk.toString() })
    request.on("end", () => {
      if (body.includes(plantedToken)) leaked = true
      let json: Record<string, unknown> = {}
      try { json = JSON.parse(body || "{}") as Record<string, unknown> } catch { /* not JSON */ }
      const tools = Array.isArray(json.tools) ? json.tools as Array<Record<string, unknown>> : []
      const toolNames = tools.map((tool) => String(tool.name ?? (tool.function as Record<string, unknown> | undefined)?.name ?? tool.type))
      const url = request.url ?? ""
      const wantsTool = kind === "anthropic"
        ? url.startsWith("/v1/messages") && !url.includes("count_tokens") && json.stream === true && toolNames.includes("Bash")
        : kind === "chat" ? toolNames.includes("bash") : toolNames.length > 0
      const callTool = !asked && wantsTool
      if (callTool) asked = true
      if (kind === "anthropic") return anthropicReply(url, json, response, callTool ? step : undefined)
      if (kind === "chat") return chatReply(response, callTool ? step : undefined)
      return responsesReply(response, callTool ? step : undefined, toolNames)
    })
  })
  const url = await listen(server)
  return { url, leaked: () => leaked, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

function anthropicReply(url: string, json: Record<string, unknown>, response: import("node:http").ServerResponse, step: Step | undefined): void {
  if (!url.startsWith("/v1/messages")) {
    response.writeHead(404).end("{}")
    return
  }
  if (url.includes("count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }))
    return
  }
  if (!json.stream) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: "msg_live", type: "message", role: "assistant", model: json.model, stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 },
    }))
    return
  }
  response.writeHead(200, { "content-type": "text/event-stream" })
  const send = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  send("message_start", { message: { id: "msg_live", type: "message", role: "assistant", model: json.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  if (step) {
    send("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_live", name: "Bash", input: {} } })
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: step.command, description: "run" }) } })
    send("content_block_stop", { index: 0 })
    send("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } })
  } else {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } })
    send("content_block_stop", { index: 0 })
    send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })
  }
  send("message_stop", {})
  response.end()
}

function chatReply(response: import("node:http").ServerResponse, step: Step | undefined): void {
  response.writeHead(200, { "content-type": "text/event-stream" })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => response.write(`data: ${JSON.stringify({
    id: "chat_live", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`)
  if (step) {
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_live", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: step.command, description: "run" }) } }] }, null)
    chunk({}, "tool_calls")
  } else {
    chunk({ role: "assistant", content: "done" }, null)
    chunk({}, "stop")
  }
  response.end("data: [DONE]\n\n")
}

function responsesReply(response: import("node:http").ServerResponse, step: Step | undefined, toolNames: string[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" })
  const send = (data: Record<string, unknown>) => response.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`)
  send({ type: "response.created", response: { id: "resp_live" } })
  if (step) {
    const name = toolNames.includes("exec_command") ? "exec_command" : "shell"
    const argumentsJson = name === "exec_command" ? { cmd: step.command } : { command: ["sh", "-c", step.command] }
    send({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_live", call_id: "call_live", name, arguments: JSON.stringify(argumentsJson) } })
  } else {
    send({ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", id: "m_live", content: [{ type: "output_text", text: "done" }] } })
  }
  send({ type: "response.completed", response: { id: "resp_live", usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } })
  response.end()
}

type Provider = {
  id: Runtime["provider"]
  binary: string
  kind: "anthropic" | "chat" | "responses"
  model: string
  adapter: (mock: Mock, home: string) => AgentAdapter
}

function embeddedFactory(provider: "opencode" | "kilo", mock: Mock): OpenCodeFactory {
  const standIn = {
    provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Stand-in", options: { baseURL: `${mock.url}/v1`, apiKey: "none" }, models: { m: { name: "M", tool_call: true } } } },
  }
  return async () => {
    if (provider === "kilo") {
      const sdkPackage = "@kilocode/sdk"
      const sdk = await import(sdkPackage) as { createKiloServer: never; createKiloClient: never }
      const runtime = await createAuthenticatedEmbeddedRuntime({
        passwordEnvironment: "KILO_SERVER_PASSWORD", usernameEnvironment: "KILO_SERVER_USERNAME", username: "kilo",
        config: { ...domovoiKiloConfig, ...standIn } as never, startServer: sdk.createKiloServer, createClient: sdk.createKiloClient,
      })
      return { client: requireOpenCodeClient(runtime.client, "Kilo"), server: runtime.server }
    }
    const sdk = await import("@opencode-ai/sdk")
    const runtime = await createAuthenticatedEmbeddedRuntime({
      passwordEnvironment: "OPENCODE_SERVER_PASSWORD", usernameEnvironment: "OPENCODE_SERVER_USERNAME", username: "opencode",
      config: { ...domovoiOpenCodeConfig, ...standIn } as never, startServer: sdk.createOpencodeServer, createClient: sdk.createOpencodeClient,
    })
    return { client: requireOpenCodeClient(runtime.client, "OpenCode"), server: runtime.server }
  }
}

const providers: Provider[] = [
  {
    id: "claude-code", binary: "claude", kind: "anthropic", model: "claude-sonnet-4-5",
    adapter: (mock, home) => {
      Object.assign(process.env, {
        CLAUDE_CONFIG_DIR: join(home, ".claude"), ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "sk-ant-stand-in",
        DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
      })
      return new ClaudeAgentSdkAdapter()
    },
  },
  {
    id: "codex", binary: "codex", kind: "responses", model: "stand-in",
    adapter: (mock, home) => {
      const codexHome = join(home, ".codex")
      mkdirSync(codexHome, { recursive: true })
      writeFileSync(join(codexHome, "config.toml"), [
        'model = "stand-in"', 'model_provider = "standin"', "[model_providers.standin]",
        'name = "Stand-in"', `base_url = "${mock.url}/v1"`, 'wire_api = "responses"', "",
      ].join("\n"))
      process.env.CODEX_HOME = codexHome
      return new CodexAppServerAdapter()
    },
  },
  { id: "opencode", binary: "opencode", kind: "chat", model: "mock/m", adapter: (mock) => new OpenCodeSdkAdapter(embeddedFactory("opencode", mock)) },
  { id: "kilo", binary: "kilo", kind: "chat", model: "mock/m", adapter: (mock) => new KiloSdkAdapter(embeddedFactory("kilo", mock)) },
]

const modes = [
  ["Ask", { permissionMode: "ask", auto: false }],
  ["Build", { permissionMode: "build", auto: false }],
  ["Build auto", { permissionMode: "build", auto: true }],
] as const

type Scenario = {
  name: string
  command: (worktree: string, outside: string) => string
  happened: (worktree: string, outside: string, mock: Mock) => boolean
}

const scenarios: Scenario[] = [
  {
    name: "reads a planted secret",
    command: () => "cat .env",
    happened: (_worktree, _outside, mock) => mock.leaked(),
  },
  {
    name: "writes outside the worktree",
    command: (_worktree, outside) => `echo written > ${join(outside, "written.txt")}`,
    happened: (_worktree, outside) => existsSync(join(outside, "written.txt")),
  },
  {
    name: "runs a destructive command",
    command: () => "rm -rf build",
    happened: (worktree) => !existsSync(join(worktree, "build", "keep.txt")),
  },
]

const cases = providers.flatMap((provider) => modes.flatMap(([mode, permission]) => scenarios.map((scenario) => ({ provider, mode, permission, scenario }))))

describe.skipIf(!live)("live provider approval contract", () => {
  it.each(cases.map((entry) => [entry.provider.id, entry.mode, entry.scenario.name, entry] as const))(
    "%s in %s: a turn that %s reaches Domovoi first and, denied, has no effect",
    async (_provider, _mode, _scenario, { provider, permission, scenario }) => {
      if (!onPath(provider.binary)) return
      const root = mkdtempSync(join(tmpdir(), "domovoi-live-contract-"))
      scratchDirectories.push(root)
      const home = join(root, "home")
      const worktree = join(root, "worktree")
      mkdirSync(join(realHome, ".cache"), { recursive: true })
      // Outside the worktree and outside the temporary directory, which Codex's
      // workspace sandbox keeps writable.
      const outside = mkdtempSync(join(realHome, ".cache", "domovoi-live-contract-"))
      scratchDirectories.push(outside)
      for (const directory of [home, join(worktree, "build")]) mkdirSync(directory, { recursive: true })
      execFileSync("git", ["init", "-q", worktree])
      writeFileSync(join(worktree, ".env"), `TOKEN=${plantedToken}\n`)
      writeFileSync(join(worktree, "build", "keep.txt"), "keep\n")
      execFileSync("git", ["-C", worktree, "add", "-f", "."])
      execFileSync("git", ["-C", worktree, "-c", "user.name=Live", "-c", "user.email=live@example.invalid", "commit", "-qm", "init"])
      const saved = { ...process.env }
      Object.assign(process.env, {
        HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
      })
      const mock = await modelStandIn(provider.kind, { command: scenario.command(worktree, outside) })
      const adapter = provider.adapter(mock, home)
      const seen: string[] = []
      let finished = false
      adapter.onEvent((event: AgentEvent) => {
        if (event.type === "approval-requested") {
          seen.push("card")
          adapter.resolveApproval(event.requestId, "deny")
        }
        if (event.type === "policy-refused") seen.push("refused")
        if (event.type === "turn-completed") finished = true
      })
      const runtime = { provider: provider.id, model: provider.model, reasoning: "medium", ...permission } as Runtime
      try {
        await adapter.connect()
        const threadId = await adapter.startThread({ cwd: worktree, runtime })
        await adapter.startTurn({ threadId, cwd: worktree, prompt: "Do the task.", runtime })
        for (let wait = 0; wait < 120 && !finished; wait += 1) await new Promise((resolve) => setTimeout(resolve, 250))
      } finally {
        await adapter.close()
        await mock.close()
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
        Object.assign(process.env, saved)
      }
      const happened = scenario.happened(worktree, outside, mock)
      console.log(`${provider.id.padEnd(11)} ${runtime.permissionMode}${runtime.auto ? "+auto" : ""}`.padEnd(24), scenario.name.padEnd(28), (seen.join(",") || "nothing asked").padEnd(14), happened ? "HAPPENED" : "contained")
      expect(happened).toBe(false)
      // In Build the request must reach Domovoi first. Codex may instead keep
      // it inside its sandbox, and Ask may be refused by the provider itself.
      if (provider.id !== "codex" && runtime.permissionMode === "build") expect(seen.length).toBeGreaterThan(0)
      expect(readFileSync(join(worktree, ".env"), "utf8")).toContain(plantedToken)
    },
    90_000,
  )
})
