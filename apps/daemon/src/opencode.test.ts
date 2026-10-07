import { waitForDaemon } from "./test-wait-for.js"
import type { ChildProcess } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, protocolVersion, workspaceSnapshotSchema, type Runtime } from "@getdomovoi/protocol"
import { WebSocket } from "ws"

import { ApprovalRequestNotPendingError, type AgentEvent } from "./agents.js"
import { embeddedServerCommand } from "./embedded-server.js"
import { KiloSdkAdapter } from "./kilo.js"
import { domovoiKiloConfig, kiloBuiltInToolIds } from "./kilo-runtime.js"
import {
  OpenCodeSdkAdapter,
  SubagentRegistry,
  domovoiOpenCodeConfig,
  openCodeAgentFor,
  openCodeAllowedPermissions,
  openCodeBuiltInToolIds,
  openCodeMessageId,
  OpenCodeMessageIdsExhaustedError,
  openCodeMessageOrder,
  permissionAnswerConfirmMs,
  type OpenCodeClient,
  type OpenCodeEvent,
  type OpenCodeFactory,
} from "./opencode.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { DomovoiDaemon } from "./server.js"
import { SqliteWorkspaceStore } from "./store.js"

const scratchDirectories: string[] = []
afterEach(async () => removeScratchDirectories(scratchDirectories.splice(0)))

class EventStream implements AsyncIterable<OpenCodeEvent> {
  #events: OpenCodeEvent[] = []
  #waiters: Array<(result: IteratorResult<OpenCodeEvent>) => void> = []
  #closed = false

  emit(event: OpenCodeEvent): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.#events.push(event)
  }

  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<OpenCodeEvent> {
    return {
      next: async () => {
        const event = this.#events.shift()
        if (event) return { value: event, done: false }
        if (this.#closed) return { value: undefined, done: true }
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

const runtime = (permissionMode: Runtime["permissionMode"], auto = false): Runtime => ({
  provider: "opencode",
  model: "anthropic/sonnet",
  reasoning: "medium",
  permissionMode,
  auto,
})

// The end of a run as OpenCode 1.18.32/1.18.33 and Kilo 7.8.1 publish it: the
// assistant message that replies to the prompt (parentID) completes
// (time.completed, and `error` when it failed), and then the session goes
// idle (SessionPrompt.runLoop, then the runner's onIdle). A turn ends only on
// that idle (security review round 8 of #687, ruling Q287).
function finishRun(stream: EventStream, threadId: string, parentID: string, options: { id?: string; error?: unknown } = {}) {
  stream.emit({
    type: "message.updated",
    properties: {
      info: {
        id: options.id ?? `reply-${parentID}`, sessionID: threadId, role: "assistant", parentID,
        time: { created: 1, completed: 2 }, ...(options.error === undefined ? {} : { error: options.error }),
      },
    },
  })
  stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness() {
  const stream = new EventStream()
  const client = {
    config: {
      get: vi.fn(async () => ({ data: { model: "anthropic/sonnet" } })),
      providers: vi.fn(async () => ({
        data: {
          default: { anthropic: "sonnet" },
          providers: [{
            id: "anthropic",
            name: "Anthropic",
            models: {
              sonnet: {
                id: "sonnet",
                providerID: "anthropic",
                name: "Claude Sonnet",
                capabilities: { reasoning: true },
                status: "active",
              },
            },
          }],
        },
      })),
    },
    session: {
      create: vi.fn(async () => ({ data: { id: "open-session" } })),
      get: vi.fn(async () => ({ data: { id: "open-session" } })),
      delete: vi.fn(async () => ({ data: true })),
      abort: vi.fn(async () => ({ data: true })),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      messages: vi.fn(async (_options?: unknown): Promise<{ data: unknown; response?: Response }> => ({ data: [] })),
      // The servers' GET /session/status: only sessions that are not idle.
      status: vi.fn(async (_options?: unknown): Promise<{ data?: unknown }> => ({ data: {} })),
    },
    event: {
      subscribe: vi.fn(async () => ({ stream })),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
    // The directory's tool servers and tool ids, read before a session opens
    // and before each prompt: none of the person's, and OpenCode's own tools.
    mcp: { status: vi.fn(async (_options?: unknown): Promise<{ data?: unknown }> => ({ data: {} })) },
    tool: { ids: vi.fn(async (_options?: unknown): Promise<{ data?: unknown }> => ({ data: [...openCodeBuiltInToolIds] })) },
    // The agents' merged rules: each asks before a tool it does not name.
    app: {
      agents: vi.fn(async (_options?: unknown): Promise<{ data?: unknown }> => ({
        data: ["build", "code", "plan", "general"].map((name) => ({ name, permission: [{ permission: "*", pattern: "*", action: "ask" }] })),
      })),
    },
  } satisfies OpenCodeClient
  const server = { url: "http://127.0.0.1:4096", processGroup: 4242, close: vi.fn(), stop: vi.fn(async () => true) }
  const factory = vi.fn(async () => ({ client, server })) satisfies OpenCodeFactory
  return { client, factory, server, stream }
}

describe("openCodeAgentFor", () => {
  it.each([
    [runtime("ask"), "domovoi-ask"],
    [runtime("plan"), "plan"],
    [runtime("build"), "build"],
    [runtime("build", true), "domovoi-auto"],
  ] as const)("maps Domovoi permissions to OpenCode agents", (input, agent) => {
    expect(openCodeAgentFor(input)).toBe(agent)
  })
})

describe("OpenCodeSdkAdapter", () => {
  it("returns the steering message identity and keeps each reply's parent across turns", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `prompt-${++id}`)
    const event = vi.fn()
    adapter.onEvent(event)
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "First", runtime: runtime("build") })
    expect(await adapter.steerTurn(threadId, turnId, "Steer")).toEqual({ providerMessageId: "prompt-2" })
    for (const parentID of ["prompt-1", "prompt-2"]) {
      stream.emit({ type: "message.updated", properties: { info: { id: `reply-${parentID}`, role: "assistant", sessionID: threadId, parentID } } })
    }
    await waitForDaemon(() => expect(event.mock.calls.filter(([value]) => value.type === "usage")).toHaveLength(2))
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    stream.emit({ type: "message.part.updated", properties: { part: { type: "text", sessionID: threadId, messageID: "reply-prompt-2" }, delta: "Steered reply" } })
    await waitForDaemon(() => expect(event).toHaveBeenCalledWith({ type: "text-delta", threadId, turnId: "prompt-2", delta: "Steered reply" }))
    await adapter.close()
  })
  it("declares read-only Ask and pre-execution Build-auto enforcement", () => {
    const { factory } = harness()
    expect(new OpenCodeSdkAdapter(factory).permissionCapabilities).toEqual({
      ask: "read-only",
      buildAuto: "pre-execution",
    })
  })

  it.each([
    ["OpenCode", domovoiOpenCodeConfig],
    ["Kilo", domovoiKiloConfig],
  ])("keeps every %s Build-auto permission behind provider approval", (_name, config) => {
    expect(config.agent?.["domovoi-auto"]?.permission).toMatchObject({
      edit: "ask",
      bash: "ask",
      webfetch: "ask",
      doom_loop: "ask",
      external_directory: "ask",
    })
  })

  it.each([
    ["OpenCode", domovoiOpenCodeConfig],
    ["Kilo", domovoiKiloConfig],
  ])("gives %s a distinct non-mutating Ask agent", (_name, config) => {
    expect(config.agent?.["domovoi-ask"]?.permission).toMatchObject({
      edit: "deny",
      bash: "deny",
      external_directory: "deny",
    })
    expect(config.agent?.["domovoi-ask"]?.tools).toEqual({
      "*": false,
      read: true,
      glob: true,
      grep: true,
      list: true,
      webfetch: true,
      websearch: true,
      question: true,
    })
  })

  it.each([true, false])("discovers configured models with reasoning capability %s without starting a model turn", async (reasoning) => {
    const { client, factory, server } = harness()
    const catalog = await client.config.providers()
    catalog.data.providers[0]!.models.sonnet.capabilities.reasoning = reasoning
    client.config.providers.mockResolvedValue(catalog)
    const adapter = new OpenCodeSdkAdapter(factory)

    await expect(adapter.listModels()).resolves.toEqual([{
      provider: "opencode",
      id: "anthropic/sonnet",
      displayName: "Anthropic / Claude Sonnet",
      description: "OpenCode model from Anthropic",
      supportedReasoningEfforts: ["unset"],
      defaultReasoningEffort: "unset",
      isDefault: true,
    }])
    expect(client.session.create).not.toHaveBeenCalled()
    await adapter.close()
    expect(server.close).toHaveBeenCalledOnce()
  })

  it("rejects malformed provider model catalogs", async () => {
    const { client, factory } = harness()
    client.config.providers.mockResolvedValueOnce({
      data: { default: {}, providers: [{ id: "anthropic", name: "Anthropic", models: [] }] },
    } as never)
    const adapter = new OpenCodeSdkAdapter(factory)

    await expect(adapter.listModels()).rejects.toThrow(
      "OpenCode provider catalog returned invalid data",
    )
    await adapter.close()
  })

  it("rejects non-string session identifiers", async () => {
    const { client, factory } = harness()
    client.session.create.mockResolvedValueOnce({ data: { id: 42 } } as never)
    const adapter = new OpenCodeSdkAdapter(factory)

    await expect(adapter.startThread({
      cwd: "/worktree",
      runtime: runtime("build"),
    })).rejects.toThrow("OpenCode session creation returned invalid data")
    await adapter.close()
  })

  it("closes a runtime whose factory finishes during adapter close", async () => {
    const { client, server } = harness()
    const factoryResult = deferred<{ client: OpenCodeClient; server: typeof server }>()
    const factory = vi.fn(() => factoryResult.promise) satisfies OpenCodeFactory
    const adapter = new OpenCodeSdkAdapter(factory)

    const connecting = adapter.connect()
    let closeFinished = false
    const closing = adapter.close().then(() => { closeFinished = true })
    await Promise.resolve()
    expect(closeFinished).toBe(false)

    factoryResult.resolve({ client, server })

    await expect(connecting).rejects.toThrow("OpenCode adapter closed")
    await expect(closing).resolves.toBeUndefined()
    expect(server.close).toHaveBeenCalledOnce()
    await expect(adapter.connect()).rejects.toThrow("OpenCode adapter closed")
    expect(factory).toHaveBeenCalledOnce()
  })

  it("continues the stream after invalid accounting and retains message identity", async () => {
    const { factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Run tests", runtime: runtime("build") })
    stream.emit({ type: "message.updated", properties: { info: {
      id: "bad", parentID: "turn-1", sessionID: threadId, role: "assistant",
      tokens: { input: 1, output: 2, total: 1 },
    } } })
    stream.emit({ type: "message.updated", properties: { info: {
      id: "good", parentID: "turn-1", sessionID: threadId, role: "assistant",
      providerID: "anthropic", modelID: "sonnet",
      tokens: { input: 4, output: 2, cache: { read: 100, write: 10 } },
      time: { created: 1, completed: 2 },
    } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed", params: expect.objectContaining({ turnId: "turn-1" }),
    })))
    expect(events).toContainEqual(expect.objectContaining({
      type: "usage", turnId: "turn-1",
      source: expect.objectContaining({ id: "good", model: "anthropic/sonnet", kind: "message" }),
      usage: expect.objectContaining({ inputTokens: 114, totalTokens: 116 }),
    }))
    expect(events).not.toContainEqual(expect.objectContaining({ type: "provider-disconnected" }))
    await adapter.close()
  })

  it("routes late accounting by parent ID and refuses unassociated message usage", async () => {
    const { factory, stream } = harness()
    let turn = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++turn}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "First", runtime: runtime("build") })
    finishRun(stream, threadId, "turn-1")
    await waitForDaemon(() => expect(events.some((event) => event.type === "turn-completed")).toBe(true))
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Second", runtime: runtime("build") })
    for (const info of [
      { id: "late", parentID: "turn-1" }, { id: "unassociated" },
    ]) stream.emit({ type: "message.updated", properties: { info: {
      ...info, sessionID: threadId, role: "assistant", tokens: { input: 10, output: 1 },
    } } })
    finishRun(stream, threadId, "turn-2")
    await waitForDaemon(() => expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(2))
    // Each turn's own reply reports its usage too; the late one goes to the
    // turn it names, and the unassociated one to none.
    expect(events.filter((event) => event.type === "usage")).toEqual([
      expect.objectContaining({ turnId: "turn-1", source: expect.objectContaining({ id: "reply-turn-1" }) }),
      expect.objectContaining({ turnId: "turn-1", source: expect.objectContaining({ id: "late" }) }),
      expect.objectContaining({ turnId: "turn-2", source: expect.objectContaining({ id: "reply-turn-2" }) }),
    ])
    await adapter.close()
  })

  it("reports missing token telemetry without inventing zero consumption", async () => {
    const { factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Run", runtime: runtime("build") })
    for (const info of [{ id: "missing" }, { id: "cost-only", tokens: {}, cost: 0.01 }]) {
      stream.emit({ type: "message.updated", properties: { info: {
        ...info, parentID: "turn-1", sessionID: threadId, role: "assistant", time: { completed: 2 },
      } } })
    }
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(events.some((event) => event.type === "turn-completed")).toBe(true))
    expect(events.filter((event) => event.type === "usage").map((event) => event.source)).toEqual([
      expect.objectContaining({ id: "missing", tokens: "unavailable" }),
      expect.objectContaining({ id: "cost-only", tokens: "unavailable" }),
    ])
    await adapter.close()
  })

  it("streams turns, tools, permissions, and completion", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const event = vi.fn()
    adapter.onEvent(event)

    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    expect(threadId).toBe("open-session")
    expect(client.session.create).toHaveBeenCalledWith(expect.objectContaining({
      query: { directory: "/worktree" },
    }))
    await expect(adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Run tests",
      runtime: runtime("build"),
    })).resolves.toBe("turn-1")
    expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: threadId },
      query: { directory: "/worktree" },
      body: expect.objectContaining({
        messageID: "turn-1",
        agent: "build",
        model: { providerID: "anthropic", modelID: "sonnet" },
        parts: [{ type: "text", text: "Run tests" }],
      }),
    }))

    stream.emit({
      type: "message.updated",
      properties: {
        info: { id: "user-message", sessionID: threadId, role: "user" },
      },
    })
    stream.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: threadId,
          messageID: "user-message",
          text: "Run tests",
        },
        delta: "Run tests",
      },
    })
    stream.emit({
      type: "message.updated",
      properties: {
        info: { id: "assistant-message", sessionID: threadId, role: "assistant", parentID: "turn-1" },
      },
    })
    stream.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: threadId,
          messageID: "assistant-message",
          text: "Tests pass.",
        },
        delta: "Tests pass.",
      },
    })
    stream.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: threadId,
          messageID: "assistant-message",
          callID: "tool-1",
          tool: "bash",
          state: { status: "running", input: { command: "pnpm test" } },
        },
      },
    })
    stream.emit({
      type: "permission.updated",
      properties: {
        id: "permission-1",
        sessionID: threadId,
        callID: "tool-1",
        title: "Run pnpm test",
        type: "bash",
        metadata: { command: "pnpm test" },
      },
    })
    await waitForDaemon(() => expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "approval-requested",
      requestId: 1,
      threadId,
      turnId: "turn-1",
      command: "pnpm test",
    })))
    adapter.resolveApproval(1, "always-project")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: threadId, permissionID: "permission-1" },
        body: { response: "once" },
      }),
    ))

    stream.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: threadId,
          messageID: "assistant-message",
          callID: "tool-1",
          tool: "bash",
          state: { status: "completed", input: { command: "pnpm test" }, output: "ok" },
        },
      },
    })
    stream.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: threadId,
          messageID: "assistant-message",
          callID: "tool-2",
          tool: "edit",
          state: { status: "completed", input: { file_path: "src/app.ts" }, output: "done" },
        },
      },
    })
    finishRun(stream, threadId, "turn-1", { id: "assistant-message" })
    await waitForDaemon(() => expect(event).toHaveBeenCalledWith({
      type: "turn-completed",
      params: {
        threadId,
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    }))
    expect(event).toHaveBeenCalledWith({
      type: "text-delta",
      threadId,
      turnId: "turn-1",
      delta: "Tests pass.",
    })
    expect(event).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "text-delta",
      delta: "Run tests",
    }))
    expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "item",
      phase: "completed",
      params: expect.objectContaining({
        item: expect.objectContaining({
          id: "tool-2",
          type: "fileChange",
          changes: [{ path: "src/app.ts" }],
        }),
      }),
    }))
    await adapter.close()
  })

  it("fails active turns and reports a disconnect when the event stream ends", async () => {
    const { client, factory, stream } = harness()
    const ids = ["turn-1", "turn-2"]
    const adapter = new OpenCodeSdkAdapter(factory, () => ids.shift()!)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Run tests",
      runtime: runtime("build"),
    })

    stream.close()
    await waitForDaemon(() => expect(events).toContainEqual({
      type: "turn-completed",
      params: {
        threadId,
        turnId: "turn-1",
        turn: { id: "turn-1", status: "failed", error: "OpenCode event stream connection closed" },
      },
    }))
    expect(events.filter((event) => event.type === "provider-disconnected")).toEqual([
      { type: "provider-disconnected", reason: "OpenCode event stream connection closed" },
    ])

    const reopened = new EventStream()
    client.event.subscribe.mockResolvedValueOnce({ stream: reopened })
    await adapter.resumeThread({ threadId, cwd: "/worktree", runtime: runtime("build") })
    expect(client.event.subscribe).toHaveBeenCalledTimes(2)
    await expect(adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Try again",
      runtime: runtime("build"),
    })).resolves.toBe("turn-2")
    finishRun(reopened, threadId, "turn-2")
    await waitForDaemon(() => expect(events).toContainEqual({
      type: "turn-completed",
      params: { threadId, turnId: "turn-2", turn: { id: "turn-2", status: "completed" } },
    }))
    await adapter.close()
  })

  it("does not report a disconnect when Domovoi stops the last thread on a directory", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Run tests",
      runtime: runtime("build"),
    })

    await adapter.stopThread(threadId)
    stream.close()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.session.abort).toHaveBeenCalledOnce()
    expect(events).toEqual([])
    await adapter.close()
  })

  it("does not load a session after it is stopped during resume", async () => {
    const { client, factory } = harness()
    let resolveSession: ((result: { data: { id: string } }) => void) | undefined
    client.session.get.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSession = resolve
    }))
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-after-stop")
    const resuming = adapter.resumeThread({
      threadId: "open-session",
      cwd: "/worktree",
      runtime: runtime("build"),
    })
    await waitForDaemon(() => expect(client.session.get).toHaveBeenCalledOnce())

    await adapter.stopThread("open-session")
    resolveSession!({ data: { id: "open-session" } })

    await expect(resuming).rejects.toThrow("OpenCode session stopped while resuming")
    expect(client.session.delete).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: "open-session" },
      query: { directory: "/worktree" },
    }))
    await expect(adapter.startTurn({
      threadId: "open-session",
      cwd: "/worktree",
      prompt: "Must not run",
      runtime: runtime("build"),
    })).rejects.toThrow("OpenCode session open-session is not loaded")
    await adapter.close()
  })
})

describe("KiloSdkAdapter", () => {
  it.each([true, false])("discovers Kilo models with reasoning capability %s without starting an inference turn", async (reasoning) => {
    const { client, factory, server } = harness()
    const catalog = await client.config.providers()
    catalog.data.providers[0]!.models.sonnet.capabilities.reasoning = reasoning
    client.config.providers.mockResolvedValue(catalog)
    const adapter = new KiloSdkAdapter(factory)

    await expect(adapter.listModels()).resolves.toEqual([{
      provider: "kilo",
      id: "anthropic/sonnet",
      displayName: "Anthropic / Claude Sonnet",
      description: "Kilo model from Anthropic",
      supportedReasoningEfforts: ["unset"],
      defaultReasoningEffort: "unset",
      isDefault: true,
    }])
    expect(client.session.create).not.toHaveBeenCalled()
    await adapter.close()
    expect(server.close).toHaveBeenCalledOnce()
  })

  it("closes a runtime whose factory finishes during adapter close", async () => {
    const { client, server } = harness()
    const factoryResult = deferred<{ client: OpenCodeClient; server: typeof server }>()
    const factory = vi.fn(() => factoryResult.promise) satisfies OpenCodeFactory
    const adapter = new KiloSdkAdapter(factory)

    const connecting = adapter.connect()
    let closeFinished = false
    const closing = adapter.close().then(() => { closeFinished = true })
    await Promise.resolve()
    expect(closeFinished).toBe(false)

    factoryResult.resolve({ client, server })

    await expect(connecting).rejects.toThrow("Kilo adapter closed")
    await expect(closing).resolves.toBeUndefined()
    expect(server.close).toHaveBeenCalledOnce()
    await expect(adapter.connect()).rejects.toThrow("Kilo adapter closed")
    expect(factory).toHaveBeenCalledOnce()
  })

  it("reports a Kilo disconnect when the event stream ends", async () => {
    const { factory, stream } = harness()
    const adapter = new KiloSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const kiloRuntime = { ...runtime("build"), provider: "kilo" }
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: kiloRuntime })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Run tests", runtime: kiloRuntime })

    stream.close()
    await waitForDaemon(() => expect(events).toContainEqual({
      type: "provider-disconnected",
      reason: "Kilo event stream connection closed",
    }))
    expect(events).toContainEqual({
      type: "turn-completed",
      params: {
        threadId,
        turnId: "turn-1",
        turn: { id: "turn-1", status: "failed", error: "Kilo event stream connection closed" },
      },
    })
    await adapter.close()
  })

  it("starts a Kilo session with Domovoi runtime controls", async () => {
    const { client, factory } = harness()
    const adapter = new KiloSdkAdapter(factory, () => "turn-1")
    const kiloRuntime = { ...runtime("build"), provider: "kilo" }

    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: kiloRuntime })
    await adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Use repo-audit",
      runtime: kiloRuntime,
    })

    expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: "open-session" },
      query: { directory: "/worktree" },
      body: expect.objectContaining({
        messageID: "turn-1",
        agent: "build",
        model: { providerID: "anthropic", modelID: "sonnet" },
        parts: [{ type: "text", text: "Use repo-audit" }],
      }),
    }))
    await adapter.close()
  })
})

describe.each([
  ["opencode", OpenCodeSdkAdapter],
  ["kilo", KiloSdkAdapter],
] as const)("%s stored reasoning compatibility", (provider, Adapter) => {
  it.each([
    ["medium", "setRuntime"], ["none", "setRuntime"], ["unset", "setRuntime"],
    ["medium", "restartProviderThread"],
  ] as const)("normalizes %s through %s, then sends no effort override", async (reasoning, method) => {
    const directory = await mkdtemp(join(tmpdir(), "domovoi-effort-"))
    scratchDirectories.push(directory)
    const { client, factory, stream } = harness()
    const adapter = new Adapter(factory, () => "effort-turn")
    // Isolate stored-runtime validation from discovery, covered above.
    vi.spyOn(adapter, "listModels").mockResolvedValue([{
      provider, id: "anthropic/sonnet", displayName: "Claude Sonnet", description: "Model default effort",
      supportedReasoningEfforts: ["unset"], defaultReasoningEffort: "unset", isDefault: true,
    }])
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions.find(({ id }) => id === "session-billing")!
    session.runtime = { ...runtime("build"), provider, reasoning }
    session.state = "idle"
    session.workspacePath = directory
    if (method === "restartProviderThread") delete session.providerThreadId
    else session.providerThreadId = "open-session"
    delete session.activeTurnId
    snapshot.approvals = []
    snapshot.approvalRules = []
    snapshot.workingPlans = []
    const store = new SqliteWorkspaceStore(":memory:", workspaceSnapshotSchema.parse(snapshot))
    const daemon = new DomovoiDaemon({
      port: 0, statePath: ":memory:", profileDirectory: directory, store, agents: { [provider]: adapter },
      artifactWatcherFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn() }),
    })
    let socket: WebSocket | undefined
    try {
      const { port } = await daemon.start()
      socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`)
      await once(socket, "open")
      const responses = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>()
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message: string } }
        if (message.id !== undefined) {
          responses.get(message.id)?.(message)
          responses.delete(message.id)
        }
      })
      let nextId = 0
      const rpc = (method: string, params: Record<string, unknown>) => new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
        const id = ++nextId
        responses.set(id, resolve)
        socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      })
      expect((await rpc("system.hello", {
        client: "desktop", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken,
      })).error).toBeUndefined()
      const loaded = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
        .sessions.find(({ id }) => id === session.id)!
      expect.soft(loaded.runtime.reasoning).toBe("unset")
      expect((await rpc("session.setRuntime", {
        sessionId: session.id, runtime: { ...loaded.runtime, reasoning: "high" }, client: "desktop",
      })).error?.message).toBe("Reasoning effort is not supported by the selected model")
      expect((await rpc(`session.${method}`, {
        sessionId: session.id, runtime: { ...loaded.runtime, reasoning }, client: "desktop",
      })).error).toBeUndefined()
      const updated = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
        .sessions.find(({ id }) => id === session.id)!
      expect(updated.runtime.reasoning).toBe("unset")
      expect((await rpc("session.send", {
        sessionId: session.id, prompt: "Hello", client: "desktop",
      })).error).toBeUndefined()
      if (method === "restartProviderThread") {
        expect(client.session.create).toHaveBeenCalledOnce()
        expect(client.session.get).not.toHaveBeenCalled()
      } else {
        expect(client.session.get).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "open-session" } }))
        expect(client.session.create).not.toHaveBeenCalled()
      }
      await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
      // Exact body equality also catches new effort or variant fields.
      expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
        body: {
          messageID: "effort-turn", agent: "build",
          model: { providerID: "anthropic", modelID: "sonnet" },
          parts: [{ type: "text", text: "Hello" }],
        },
      }))
      finishRun(stream, "open-session", "effort-turn")
      await waitForDaemon(async () => {
        const current = workspaceSnapshotSchema.parse((await rpc("workspace.get", {})).result)
          .sessions.find(({ id }) => id === session.id)!
        expect(current.activeTurnId).toBeUndefined()
      })
    } finally {
      socket?.terminate()
      await daemon.stop()
    }
  })
})

describe("repository instruction files", () => {
  it.each([
    ["OpenCode", (factory: OpenCodeFactory) => new OpenCodeSdkAdapter(factory)],
    ["Kilo", (factory: OpenCodeFactory) => new KiloSdkAdapter(factory)],
  ])("sends %s the worktree's AGENTS.md itself, since project configuration stays off", async (_name, create) => {
    const worktree = await mkdtemp(join(tmpdir(), "domovoi-opencode-instructions-"))
    scratchDirectories.push(worktree)
    await writeFile(join(worktree, "AGENTS.md"), "Shared agent rule\n")
    await writeFile(join(worktree, "CLAUDE.md"), "Claude only rule\n")
    const { client, factory } = harness()
    const adapter = create(factory)

    const threadId = await adapter.startThread({ cwd: worktree, runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: worktree, prompt: "Hello", runtime: runtime("build") })

    expect(client.session.promptAsync).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        system: expect.stringMatching(/^Instructions from: .*AGENTS\.md\nShared agent rule/),
      }),
    }))
    expect(client.session.promptAsync).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.objectContaining({ system: expect.not.stringContaining("Claude only rule") }),
    }))
    await adapter.close()
  })

  it("sends no system text for a worktree without instruction files", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "domovoi-opencode-bare-"))
    scratchDirectories.push(worktree)
    const { client, factory } = harness()
    const adapter = new OpenCodeSdkAdapter(factory)

    const threadId = await adapter.startThread({ cwd: worktree, runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: worktree, prompt: "Hello", runtime: runtime("build") })

    expect(client.session.promptAsync).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.not.objectContaining({ system: expect.anything() }),
    }))
    await adapter.close()
  })
})

// Security review round 8 of #687 (ruling Q287): a turn ends by message
// identity, not by counting idles. An interrupted turn ends on the abort's
// answer; anything the interrupted run publishes after that ends nothing, and
// the next turn ends only on an idle after its own reply has completed.
describe("an interrupted turn's end that arrives late", () => {
  const turnEnds = (events: AgentEvent[], turnId: string) => events.filter((event) => event.type === "turn-completed" && event.params.turnId === turnId)

  it("ends the interrupted turn on the abort's answer and does not complete the turn sent after it", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const first = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    stream.emit({ type: "message.updated", properties: { info: { id: first, sessionID: threadId, role: "user" } } })
    await adapter.interruptTurn(threadId, first)
    expect(turnEnds(events, first)).toEqual([expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ status: "failed", error: "The OpenCode turn was interrupted." }) }) })])
    const second = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Two", runtime: runtime("build") })

    // The interrupted run's end, delivered late: an error and two idles (the
    // processor's halt, then the runner's cancel).
    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "MessageAbortedError", data: { message: "aborted" } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    // The new turn's own prompt, and an idle before its reply has completed.
    stream.emit({ type: "message.updated", properties: { info: { id: second, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnds(events, second)).toEqual([])

    finishRun(stream, threadId, second)
    await waitForDaemon(() => expect(turnEnds(events, second)).toEqual([expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ status: "completed" }) }) })]))
    expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(2)
    await adapter.close()
  })

  // A run that fails before any reply (an unknown agent, say) publishes an
  // error and then goes idle. Before the turn's own prompt shows, neither is
  // the turn's.
  it("ends a turn that fails before any reply only on an error and idle after its own prompt", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })

    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "UnknownError", data: { message: "earlier run" } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnds(events, turnId)).toEqual([])

    stream.emit({ type: "message.updated", properties: { info: { id: turnId, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "ProviderAuthError", data: { message: "no key" } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(turnEnds(events, turnId)).toEqual([expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ status: "failed", error: expect.stringContaining("no key") }) }) })]))
    await adapter.close()
  })

  // A run that fails during a reply ends through the processor's halt: an
  // error and an idle, then the reply is published as failed, then the
  // runner's idle. Only the idle after the failed reply ends the turn.
  it("ends a turn whose reply fails only on the idle after that reply ends", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    stream.emit({ type: "message.updated", properties: { info: { id: turnId, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "reply", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 1 } } } })
    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "APIError", data: { message: "overloaded" } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnds(events, turnId)).toEqual([])

    finishRun(stream, threadId, turnId, { id: "reply", error: { name: "APIError", data: { message: "overloaded" } } })
    await waitForDaemon(() => expect(turnEnds(events, turnId)).toEqual([expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ status: "failed", error: expect.stringContaining("overloaded") }) }) })]))
    await adapter.close()
  })

  // A steer's reply names the steer as its parent; it is the turn's reply.
  it("ends a turn on the idle after its steer's reply completes", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    const { providerMessageId: steer } = await adapter.steerTurn(threadId, turnId, "Also")
    stream.emit({ type: "message.updated", properties: { info: { id: "first-reply", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 1, completed: 2 } } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "steer-reply", sessionID: threadId, role: "assistant", parentID: steer, time: { created: 3 } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnds(events, turnId)).toEqual([])

    finishRun(stream, threadId, steer, { id: "steer-reply" })
    await waitForDaemon(() => expect(turnEnds(events, turnId)).toEqual([expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ status: "completed" }) }) })]))
    await adapter.close()
  })

  // A subagent's idle ends its task tool call, never the parent's turn.
  it("does not end the parent's turn on a subagent's idle", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    stream.emit({ type: "message.updated", properties: { info: { id: "reply", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 1, completed: 2 } } } })
    stream.emit({ type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: threadId, directory: "/worktree" } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "child-reply", sessionID: "ses_child", role: "assistant", parentID: "child-user", time: { created: 1, completed: 2 } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: "ses_child" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnds(events, turnId)).toEqual([])

    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(turnEnds(events, turnId)).toHaveLength(1))
    await adapter.close()
  })
})

describe("message ids", () => {
  it.each([
    ["OpenCode", (factory: OpenCodeFactory) => new OpenCodeSdkAdapter(factory)],
    ["Kilo", (factory: OpenCodeFactory) => new KiloSdkAdapter(factory)],
  ])("sends %s ascending msg_ ids, the only message ids its server accepts", async (_name, create) => {
    const { client, factory } = harness()
    const adapter = create(factory)
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })

    const first = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    const steered = await adapter.steerTurn(threadId, first, "Also")
    const ids = client.session.promptAsync.mock.calls.map((call) => (call as unknown as [{ body: { messageID: string } }])[0].body.messageID)

    expect(ids).toHaveLength(2)
    for (const id of ids) expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(ids[0]).toBe(first)
    expect(ids[1]).toBe(steered.providerMessageId)
    expect(ids[1]! > ids[0]!).toBe(true)
    await adapter.close()
  })
})

describe("openCodeMessageId", () => {
  it("encodes the time exactly as the servers do", () => {
    // Ids the installed opencode 1.18.32 and kilo 7.7.6 servers made, with the
    // creation time each reported for that message.
    for (const [serverPrefix, created] of [
      ["0cc7b53c0001", 1_790_137_029_568],
      ["0cc7b5486001", 1_790_137_029_766],
      ["0cc7b57f9001", 1_790_137_030_649],
      ["0cc7b57fd001", 1_790_137_030_653],
      ["0cc7b5f49001", 1_790_137_032_521],
      ["0cc7b625d001", 1_790_137_033_309],
    ] as const) {
      expect(openCodeMessageOrder(created)).toBe(serverPrefix)
    }
  })

  it("keeps rising when the clock steps back", () => {
    const now = Date.now() + 60_000
    const before = openCodeMessageId(now)
    const after = openCodeMessageId(now - 5_000)

    expect(after > before).toBe(true)
  })

  it("moves to the next millisecond instead of spilling the counter into the time", () => {
    const now = Date.now() + 120_000
    const ids = Array.from({ length: 4_097 }, () => openCodeMessageId(now))

    for (let index = 1; index < ids.length; index += 1) expect(ids[index]! > ids[index - 1]!).toBe(true)
    expect(ids.at(-1)!.slice(4, 16)).toBe(openCodeMessageOrder(now + 1, 1))
  })

  it("sorts after an id it is told to follow", () => {
    const later = `msg_${openCodeMessageOrder(Date.now() + 600_000, 7)}zzzzzzzzzzzzzz`

    expect(openCodeMessageId(Date.now(), later) > later).toBe(true)
  })

  // The servers keep 48 bits of order. Nothing sorts after the last value, so
  // an id is refused there instead of wrapping to zero and sorting first.
  it("refuses to follow an id at the last 48-bit order instead of wrapping to zero", () => {
    const last = "msg_ffffffffffffAAAAAAAAAAAAAA"

    expect(() => openCodeMessageId(Date.now(), last)).toThrow(OpenCodeMessageIdsExhaustedError)
  })

  it("keeps making ids for other sessions after one session's ids ran out", () => {
    expect(() => openCodeMessageId(Date.now(), "msg_fffffffffffeAAAAAAAAAAAAAA")).not.toThrow()
    const next = openCodeMessageId(Date.now())

    expect(next.slice(4, 16) < "ffffffffffff").toBe(true)
  })
})

describe("message order across processes", () => {
  it("resumes after the newest message the server already holds", async () => {
    const { client, factory } = harness()
    const history = `msg_${openCodeMessageOrder(Date.now() + 3_600_000)}AAAAAAAAAAAAAA`
    client.session.messages.mockResolvedValueOnce({ data: [{ info: { id: history } }] })
    const adapter = new OpenCodeSdkAdapter(factory)

    await adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId: "open-session", cwd: "/worktree", prompt: "Go", runtime: runtime("build") })

    expect(client.session.messages).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: "open-session" },
      query: expect.objectContaining({ directory: "/worktree" }),
    }))
    expect(turnId > history).toBe(true)
    await adapter.close()
  })

  it("refuses a turn in a session whose history holds the last message order", async () => {
    const { client, factory } = harness()
    client.session.messages.mockResolvedValueOnce({ data: [{ info: { id: "msg_ffffffffffffAAAAAAAAAAAAAA" } }] })
    const adapter = new OpenCodeSdkAdapter(factory)

    await adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") })
    await expect(adapter.startTurn({ threadId: "open-session", cwd: "/worktree", prompt: "Go", runtime: runtime("build") }))
      .rejects.toThrow("OpenCode session has used the last message id the server can order, so it cannot take another message")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    await adapter.close()
  })

  it("resumes after the greatest id in the whole history, not the newest by time", async () => {
    const { client, factory } = harness()
    const base = Date.now() + 10_800_000
    // A clock that stepped back gave the later-created message the lower id.
    const newerByTime = `msg_${openCodeMessageOrder(base)}CCCCCCCCCCCCCC`
    const greatest = `msg_${openCodeMessageOrder(base + 5_000)}DDDDDDDDDDDDDD`
    client.session.messages
      .mockResolvedValueOnce({ data: [{ info: { id: newerByTime } }], response: new Response(null, { headers: { "x-next-cursor": "page-2" } }) })
      .mockResolvedValueOnce({ data: [{ info: { id: greatest } }], response: new Response(null) })
    const adapter = new OpenCodeSdkAdapter(factory)

    await adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId: "open-session", cwd: "/worktree", prompt: "Go", runtime: runtime("build") })

    expect(client.session.messages).toHaveBeenCalledTimes(2)
    expect(client.session.messages).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({ before: "page-2" }),
    }))
    expect(turnId > greatest).toBe(true)
    await adapter.close()
  })

  it.each([
    ["the same cursor twice in a row", ["page-2", "page-2"]],
    ["a cursor that comes back after another page", ["page-2", "page-3", "page-2"]],
  ])("refuses to resume when the history repeats %s", async (_label, cursors) => {
    const { client, factory } = harness()
    for (const cursor of cursors) {
      client.session.messages.mockResolvedValueOnce({ data: [{ info: { id: "msg_000000000001AAAAAAAAAAAAAA" } }], response: new Response(null, { headers: { "x-next-cursor": cursor } }) })
    }
    const adapter = new OpenCodeSdkAdapter(factory)

    await expect(adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") }))
      .rejects.toThrow("OpenCode session history repeated a page")
    await adapter.close()
  })

  it("reads the whole history at once when a full page comes back without a cursor", async () => {
    const { client, factory } = harness()
    const base = Date.now() + 18_000_000
    const page = Array.from({ length: 200 }, (_, index) => ({ info: { id: `msg_${openCodeMessageOrder(base, index + 1)}GGGGGGGGGGGGGG` } }))
    const unread = `msg_${openCodeMessageOrder(base + 60_000)}HHHHHHHHHHHHHH`
    client.session.messages
      .mockResolvedValueOnce({ data: page, response: new Response(null) })
      .mockResolvedValueOnce({ data: [...page, { info: { id: unread } }], response: new Response(null) })
    const adapter = new OpenCodeSdkAdapter(factory)

    await adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId: "open-session", cwd: "/worktree", prompt: "Go", runtime: runtime("build") })

    expect(client.session.messages).toHaveBeenCalledTimes(2)
    const fallback = client.session.messages.mock.calls[1]![0] as { query: Record<string, unknown> }
    expect(fallback.query).not.toHaveProperty("limit")
    expect(fallback.query).not.toHaveProperty("before")
    expect(turnId > unread).toBe(true)
    await adapter.close()
  })

  it("refuses to resume when the whole-history read after a full page fails", async () => {
    const { client, factory } = harness()
    const page = Array.from({ length: 200 }, (_, index) => ({ info: { id: `msg_${openCodeMessageOrder(Date.now(), index + 1)}JJJJJJJJJJJJJJ` } }))
    client.session.messages
      .mockResolvedValueOnce({ data: page, response: new Response(null) })
      .mockRejectedValueOnce(new Error("history unavailable"))
    const adapter = new OpenCodeSdkAdapter(factory)

    await expect(adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") }))
      .rejects.toThrow("history unavailable")
    await adapter.close()
  })

  it("ends normally on a short last page without a cursor", async () => {
    const { client, factory } = harness()
    client.session.messages.mockResolvedValueOnce({ data: [{ info: { id: "msg_000000000001KKKKKKKKKKKKKK" } }], response: new Response(null) })
    const adapter = new OpenCodeSdkAdapter(factory)

    await adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") })
    expect(client.session.messages).toHaveBeenCalledTimes(1)
    await adapter.close()
  })

  it("counts a message another client creates while the history is being read", async () => {
    const { client, factory, stream } = harness()
    const base = Date.now() + 14_400_000
    const inHistory = `msg_${openCodeMessageOrder(base)}EEEEEEEEEEEEEE`
    const midScan = `msg_${openCodeMessageOrder(base + 9_000)}FFFFFFFFFFFFFF`
    client.session.messages.mockImplementationOnce(async () => {
      // Like the server's event stream, an event reaches only a subscriber that
      // is already listening.
      if (client.event.subscribe.mock.calls.length > 0) {
        stream.emit({ type: "message.updated", properties: { info: { id: midScan, sessionID: "open-session", role: "user" } } })
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { data: [{ info: { id: inHistory } }], response: new Response(null) }
    })
    const adapter = new OpenCodeSdkAdapter(factory)

    await adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId: "open-session", cwd: "/worktree", prompt: "Go", runtime: runtime("build") })

    expect(turnId > midScan).toBe(true)
    await adapter.close()
  })

  it("refuses a resume that was stopped while the history was being read", async () => {
    const { client, factory } = harness()
    const adapter = new OpenCodeSdkAdapter(factory)
    client.session.messages.mockImplementationOnce(async () => {
      await adapter.stopThread("open-session")
      return { data: [], response: new Response(null) }
    })

    await expect(adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") }))
      .rejects.toThrow("OpenCode session stopped while resuming")
    await expect(adapter.startTurn({ threadId: "open-session", cwd: "/worktree", prompt: "Go", runtime: runtime("build") }))
      .rejects.toThrow("is not loaded")
    await adapter.close()
  })

  it("follows a message the server made after the last prompt", async () => {
    const { factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory)
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const first = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    const reply = `msg_${openCodeMessageOrder(Date.now() + 7_200_000)}BBBBBBBBBBBBBB`
    stream.emit({ type: "message.updated", properties: { info: { id: reply, sessionID: threadId, role: "assistant", parentID: first } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const second = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Two", runtime: runtime("build") })

    expect(second > reply).toBe(true)
    await adapter.close()
  })
})

describe("subagents and current permission events", () => {
  it.each([
    ["OpenCode", domovoiOpenCodeConfig],
    ["Kilo", domovoiKiloConfig],
  ])("makes every %s agent, built-in subagents included, ask before it edits, runs or fetches", (_name, config) => {
    expect(config.permission).toMatchObject({
      edit: "ask",
      bash: "ask",
      webfetch: "ask",
      doom_loop: "ask",
      external_directory: "ask",
    })
  })

  async function buildTurn() {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Explore", runtime: runtime("build") })
    return { adapter, client, events, stream, threadId }
  }

  it("raises an approval for the permission.asked event the current server sends", async () => {
    const { adapter, client, events, stream, threadId } = await buildTurn()

    stream.emit({
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: threadId,
        permission: "bash",
        patterns: ["pnpm test"],
        metadata: { command: "pnpm test" },
        always: ["pnpm *"],
        tool: { messageID: "msg_1", callID: "call_1" },
      },
    })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "approval-requested",
      threadId,
      turnId: "turn-1",
      itemId: "call_1",
      command: "pnpm test",
    })))
    adapter.resolveApproval(1, "deny")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: threadId, permissionID: "per_1" }, body: { response: "reject" } }),
    ))
    await adapter.close()
  })

  // Only bash with its command is a shell command. An edit of one file is the
  // Edit file tool on that file, so its Always stays a file rule. Every other
  // permission (webfetch, external_directory, a tool server's tool, whose
  // permission is its own name) is the provider's tool and is never resolved
  // as a shell command.
  it("names each permission as a shell command, a file edit or a provider tool", async () => {
    const { adapter, events, stream, threadId } = await buildTurn()
    const ask = (id: string, permission: string, patterns: string[], metadata: Record<string, unknown>) => stream.emit({
      type: "permission.asked",
      properties: { id, sessionID: threadId, permission, patterns, metadata, always: ["*"], tool: { messageID: "msg_1", callID: `call_${id}` } },
    })
    ask("per_edit", "edit", ["src/a.ts"], { filepath: "/worktree/src/a.ts", diff: "-a\n+b" })
    ask("per_fetch", "webfetch", ["https://example.test"], { url: "https://example.test" })
    ask("per_outside", "external_directory", ["/etc/*"], { filepath: "/etc/hosts", parentDir: "/etc" })
    ask("per_mcp", "github_create_issue", ["*"], {})
    ask("per_bash", "bash", ["pnpm test"], {})
    ask("per_patch", "edit", ["src/a.ts", "src/b.ts"], { filepath: "src/a.ts, src/b.ts", diff: "" })
    ask("per_empty", "", ["pwd"], { command: "pwd" })
    stream.emit({
      type: "permission.asked",
      properties: { id: "per_nameless", sessionID: threadId, permission: 7, patterns: [], metadata: { command: "pwd" }, always: [], tool: { messageID: "msg_1", callID: "call_nameless" } },
    } as unknown as OpenCodeEvent)
    // Security review round 2 of #665: a current event names its permission;
    // the legacy `type` is read only from permission.updated.
    stream.emit({
      type: "permission.updated",
      properties: { id: "per_legacy_bash", sessionID: threadId, callID: "call_legacy_bash", type: "bash", title: "Run pwd", metadata: { command: "pwd" } },
    })
    stream.emit({
      type: "permission.asked",
      properties: { id: "per_typed", sessionID: threadId, permission: 7, type: "bash", patterns: [], metadata: { command: "pwd" }, always: [], tool: { messageID: "msg_1", callID: "call_typed" } },
    } as unknown as OpenCodeEvent)
    stream.emit({
      type: "permission.updated",
      properties: { id: "per_legacy", sessionID: threadId, callID: "call_legacy", type: "edit", title: "Edit this file: /worktree/src/c.ts", metadata: { filePath: "/worktree/src/c.ts" } },
    })
    await waitForDaemon(() => expect(events.filter((event) => event.type === "approval-requested")).toHaveLength(11))
    const approval = (itemId: string) => events.find((event) => event.type === "approval-requested" && event.itemId === itemId)
    // A permission with no name is still a provider tool, never shell text.
    expect(approval("call_per_empty")).toMatchObject({ command: "pwd", tool: "unknown" })
    expect(approval("call_nameless")).toMatchObject({ command: "pwd", tool: "unknown" })
    expect(approval("call_typed")).toMatchObject({ command: "pwd", tool: "unknown" })
    expect(approval("call_legacy_bash")).toMatchObject({ command: "pwd" })
    expect(approval("call_legacy_bash")).not.toHaveProperty("tool")
    expect(approval("call_per_edit")).toMatchObject({ command: "Edit", path: "/worktree/src/a.ts" })
    expect(approval("call_per_edit")).not.toHaveProperty("tool")
    expect(approval("call_legacy")).toMatchObject({ command: "Edit", path: "/worktree/src/c.ts" })
    expect(approval("call_legacy")).not.toHaveProperty("tool")
    expect(approval("call_per_fetch")).toMatchObject({ tool: "webfetch" })
    expect(approval("call_per_outside")).toMatchObject({ tool: "external_directory" })
    expect(approval("call_per_mcp")).toMatchObject({ tool: "github_create_issue" })
    expect(approval("call_per_bash")).toMatchObject({ tool: "bash" })
    expect(approval("call_per_patch")).toMatchObject({ tool: "edit" })
    expect(approval("call_per_patch")).not.toHaveProperty("path")
    await adapter.close()
  })

  // A tool server's tool asks under its key, the server's name and the tool's
  // joined by one `_` (opencode mcp/catalog.ts toolName). The card names the
  // server only when exactly one server the session's directory knows could
  // have made the key, and never for one of the server's own tools.
  it.each([
    ["OpenCode", (factory: OpenCodeFactory) => new OpenCodeSdkAdapter(factory)],
    ["Kilo", (factory: OpenCodeFactory) => new KiloSdkAdapter(factory)],
  ] as const)("names the tool server a %s tool call belongs to", async (_name, create) => {
    const { client, factory, stream } = harness()
    const status = vi.fn(async (_options?: unknown) => ({
      data: {
        github: { status: "connected" }, git: { status: "connected" }, git_hub: { status: "failed" },
        "my.docs": { status: "connected" },
      },
    }))
    const adapter = create(() => factory().then((runtime) => ({ ...runtime, client: { ...client, mcp: { status } } })))
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Call tools", runtime: runtime("build") })
    await waitForDaemon(() => expect(status).toHaveBeenCalledWith(expect.objectContaining({ query: { directory: "/worktree" } })))
    const ask = (id: string, permission: string) => stream.emit({
      type: "permission.asked",
      properties: { id, sessionID: threadId, permission, patterns: ["*"], metadata: {}, always: ["*"], tool: { messageID: "msg_1", callID: `call_${id}` } },
    })
    ask("issue", "github_create_issue")
    ask("ambiguous", "git_hub_status")
    ask("only_git", "git_status")
    ask("dotted", "my_docs_search")
    ask("builtin", "doom_loop")
    ask("unknown", "slack_post")
    await waitForDaemon(() => expect(events.filter((event) => event.type === "approval-requested")).toHaveLength(6))
    const approval = (itemId: string) => events.find((event) => event.type === "approval-requested" && event.itemId === itemId)
    expect(approval("call_issue")).toMatchObject({ tool: "github_create_issue", toolServer: { name: "github" } })
    expect(approval("call_only_git")).toMatchObject({ tool: "git_status", toolServer: { name: "git" } })
    expect(approval("call_dotted")).toMatchObject({ tool: "my_docs_search", toolServer: { name: "my.docs" } })
    for (const itemId of ["call_ambiguous", "call_builtin", "call_unknown"]) expect(approval(itemId)).not.toHaveProperty("toolServer")
    await adapter.close()
  })

  // Security review round 1 of #687 (P2): a card for a tool the catalog cannot
  // place waits for the directory's tool servers to be read again, for a
  // bounded time, and a read that fails is tried again for the next card.
  it("reads the tool servers again before raising a card the catalog cannot place", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Call tools", runtime: runtime("build") })
    const ask = (id: string, permission: string) => stream.emit({
      type: "permission.asked",
      properties: { id, sessionID: threadId, permission, patterns: ["*"], metadata: {}, always: ["*"], tool: { messageID: "msg_1", callID: `call_${id}` } },
    })
    // A server the directory gained after the prompt's read; the first read
    // for its card fails, the next card's succeeds.
    client.mcp.status.mockRejectedValueOnce(new Error("busy"))
    client.mcp.status.mockResolvedValue({ data: { github: { status: "connected" } } })
    ask("first", "github_create_issue")
    await waitForDaemon(() => expect(events.filter((event) => event.type === "approval-requested")).toHaveLength(1))
    expect(events.find((event) => event.type === "approval-requested")).not.toHaveProperty("toolServer")
    ask("second", "github_close_issue")
    await waitForDaemon(() => expect(events.filter((event) => event.type === "approval-requested")).toHaveLength(2))
    expect(events.filter((event) => event.type === "approval-requested")[1]).toMatchObject({ itemId: "call_second", toolServer: { name: "github" } })
    await adapter.close()
  })

  it("raises the card without a tool server once the read has taken too long", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Call tools", runtime: runtime("build") })
    client.mcp.status.mockImplementation(() => new Promise(() => {}))
    stream.emit({
      type: "permission.asked",
      properties: { id: "slow", sessionID: threadId, permission: "github_create_issue", patterns: ["*"], metadata: {}, always: ["*"], tool: { messageID: "msg_1", callID: "call_slow" } },
    })
    // The read is bounded at one second; the card comes within a few.
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "approval-requested", itemId: "call_slow" })), { timeout: 5_000 })
    expect(events.find((event) => event.type === "approval-requested")).not.toHaveProperty("toolServer")
    await adapter.close()
  })

  it("raises a card for one of the server's own permissions without reading again", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Fetch", runtime: runtime("build") })
    const reads = client.mcp.status.mock.calls.length
    stream.emit({
      type: "permission.asked",
      properties: { id: "fetch", sessionID: threadId, permission: "webfetch", patterns: ["https://example.test"], metadata: {}, always: ["*"], tool: { messageID: "msg_1", callID: "call_fetch" } },
    })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "approval-requested", itemId: "call_fetch" })))
    expect(client.mcp.status.mock.calls.length).toBe(reads)
    await adapter.close()
  })

  // Security review round 1 of #687 (P2): the card's tool server comes from
  // the directory's catalog. A tool listed among the tool ids is a plugin's
  // or the server's own, never a tool server's, and a server's name is made a
  // key prefix exactly as OpenCode makes it: each UTF-16 unit outside
  // [a-zA-Z0-9_-] becomes `_`.
  it("names a tool server from the directory's catalog, as OpenCode names its tools", async () => {
    const { client, factory, stream } = harness()
    client.mcp.status.mockResolvedValue({ data: { docs: { status: "connected" }, "team🔥x": { status: "connected" } } })
    client.tool.ids.mockResolvedValue({ data: [...openCodeBuiltInToolIds, "docs_publish"] })
    const adapter = new OpenCodeSdkAdapter(factory)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Call tools", runtime: runtime("build") })
    const ask = (id: string, permission: string) => stream.emit({
      type: "permission.asked",
      properties: { id, sessionID: threadId, permission, patterns: ["*"], metadata: {}, always: ["*"], tool: { messageID: "msg_1", callID: `call_${id}` } },
    })
    ask("plugin", "docs_publish")
    ask("emoji", "team__x_search")
    ask("server", "docs_search")
    await waitForDaemon(() => expect(events.filter((event) => event.type === "approval-requested")).toHaveLength(3))
    const approval = (itemId: string) => events.find((event) => event.type === "approval-requested" && event.itemId === itemId)
    expect(approval("call_plugin")).not.toHaveProperty("toolServer")
    expect(approval("call_emoji")).toMatchObject({ toolServer: { name: "team🔥x" } })
    expect(approval("call_server")).toMatchObject({ toolServer: { name: "docs" } })
    await adapter.close()
  })

  it("routes a subagent's approvals and commands to the parent thread and answers the child session", async () => {
    const { adapter, client, events, stream, threadId } = await buildTurn()
    const child = "ses_child"

    stream.emit({ type: "session.created", properties: { sessionID: child, info: { id: child, parentID: threadId, directory: "/worktree" } } })
    stream.emit({
      type: "permission.asked",
      properties: {
        id: "per_child",
        sessionID: child,
        permission: "bash",
        patterns: ["rm -rf build"],
        metadata: { command: "rm -rf build" },
        always: ["rm *"],
        tool: { messageID: "msg_child", callID: "call_child" },
      },
    })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "approval-requested",
      threadId,
      turnId: "turn-1",
      itemId: "call_child",
      command: "rm -rf build",
    })))
    adapter.resolveApproval(1, "allow-once")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: child, permissionID: "per_child" }, body: { response: "once" } }),
    ))

    stream.emit({ type: "message.updated", properties: { info: { id: "msg_child", sessionID: child, role: "assistant", parentID: "child-user" } } })
    stream.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: child,
          messageID: "msg_child",
          callID: "call_child",
          tool: "bash",
          state: { status: "completed", input: { command: "rm -rf build" }, output: "" },
        },
      },
    })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "item",
      phase: "completed",
      params: expect.objectContaining({
        threadId,
        turnId: "turn-1",
        item: expect.objectContaining({ type: "commandExecution", id: "call_child", command: ["rm -rf build"] }),
      }),
    })))

    // Even once the parent's reply has completed, the child's idle ends only
    // the child's task, not the parent's turn.
    stream.emit({ type: "message.updated", properties: { info: { id: "reply-turn-1", sessionID: threadId, role: "assistant", parentID: "turn-1", time: { created: 1, completed: 2 } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: child } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).not.toContainEqual(expect.objectContaining({ type: "turn-completed" }))
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "turn-completed" })))
    await adapter.close()
  })

  async function childAskedInFirstTurn(beforeTurnEnd?: (client: ReturnType<typeof harness>["client"]) => void) {
    const { client, factory, stream } = harness()
    let turns = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++turns}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Explore", runtime: runtime("build") })
    const child = "ses_child"
    stream.emit({ type: "session.created", properties: { sessionID: child, info: { id: child, parentID: threadId, directory: "/worktree" } } })
    stream.emit({
      type: "permission.asked",
      properties: {
        id: "per_child",
        sessionID: child,
        permission: "bash",
        patterns: ["rm -rf build"],
        metadata: { command: "rm -rf build" },
        always: ["rm *"],
        tool: { messageID: "msg_child", callID: "call_child" },
      },
    })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "approval-requested", requestId: 1, threadId, turnId: "turn-1",
    })))
    beforeTurnEnd?.(client)
    finishRun(stream, threadId, "turn-1", { error: { name: "UnknownError", data: { message: "parent failed" } } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed", params: expect.objectContaining({ turnId: "turn-1" }),
    })))
    return { adapter, client, events, stream, threadId, child }
  }

  const askFrom = (sessionID: string, id: string) => ({
    type: "permission.asked" as const,
    properties: { id, sessionID, permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, always: [] },
  })

  // Never adopted, and outside any turn: security review round 7 of #687
  // (ruling Q277) refuses its approval requests with no card and aborts it.
  it("never adopts a child first seen while its thread has no active turn", async () => {
    const { client, factory, stream } = harness()
    let turns = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++turns}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    stream.emit({ type: "session.created", properties: { sessionID: "ses_between", info: { id: "ses_between", parentID: threadId } } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Go", runtime: runtime("build") })
    stream.emit({ type: "session.updated", properties: { sessionID: "ses_between", info: { id: "ses_between", parentID: threadId } } })
    stream.emit({ type: "session.created", properties: { sessionID: "ses_grandchild", info: { id: "ses_grandchild", parentID: "ses_between" } } })
    stream.emit(askFrom("ses_between", "per_between"))
    stream.emit(askFrom("ses_grandchild", "per_grandchild"))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events.filter((event) => event.type === "approval-requested")).toEqual([])
    for (const [session, permission] of [["ses_between", "per_between"], ["ses_grandchild", "per_grandchild"]] as const) {
      expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(expect.objectContaining({ path: { id: session, permissionID: permission }, body: { response: "reject" } }))
      expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: session } }))
    }
    expect(client.session.abort).not.toHaveBeenCalledWith(expect.objectContaining({ path: { id: threadId } }))
    await adapter.close()
  })

  it("keeps a failed refusal and refuses again when the card is answered later", async () => {
    const { adapter, client } = await childAskedInFirstTurn((client) => {
      client.postSessionIdPermissionsPermissionId.mockRejectedValueOnce(new Error("provider busy"))
    })
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1))

    adapter.resolveApproval(1, "allow-once")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(2))
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: { id: "ses_child", permissionID: "per_child" }, body: { response: "reject" } }),
    )
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: "once" } }),
    )
    await adapter.close()
  })

  it("retries a failed refusal when the thread's next turn starts", async () => {
    const { adapter, client, threadId } = await childAskedInFirstTurn((client) => {
      client.postSessionIdPermissionsPermissionId.mockRejectedValueOnce(new Error("provider busy"))
    })
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1))

    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(2))
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: { id: "ses_child", permissionID: "per_child" }, body: { response: "reject" } }),
    )
    await adapter.close()
  })

  it("refuses a child's pending approval when its thread is stopped, so a later answer sends nothing", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Go", runtime: runtime("build") })
    stream.emit({ type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: threadId } } })
    stream.emit(askFrom("ses_child", "per_child"))
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "approval-requested", requestId: 1 })))

    await adapter.stopThread(threadId)
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "ses_child", permissionID: "per_child" }, body: { response: "reject" } }),
    ))
    // The request is no longer waiting, so the answer says it reached
    // nothing (ruling Q285).
    expect(() => adapter.resolveApproval(1, "allow-once")).toThrow(ApprovalRequestNotPendingError)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: "once" } }),
    )
    await adapter.close()
  })

  it("fails the turn and unloads the thread when the provider deletes its session", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Go", runtime: runtime("build") })

    stream.emit({ type: "session.deleted", properties: { info: { id: threadId } } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed",
      params: expect.objectContaining({ turn: expect.objectContaining({ status: "failed", error: "OpenCode deleted the session" }) }),
    })))
    await expect(adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Again", runtime: runtime("build") }))
      .rejects.toThrow("is not loaded")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    await adapter.close()
  })

  it("drops a deleted child's pending and failed refusals instead of retrying them every turn", async () => {
    const { adapter, client, stream, threadId } = await childAskedInFirstTurn((client) => {
      client.postSessionIdPermissionsPermissionId.mockRejectedValueOnce(new Error("provider busy"))
    })
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1))

    stream.emit({ type: "session.deleted", properties: { info: { id: "ses_child", parentID: threadId } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    // The request is no longer waiting, so the answer says it reached
    // nothing (ruling Q285).
    expect(() => adapter.resolveApproval(1, "allow-once")).toThrow(ApprovalRequestNotPendingError)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1)
    await adapter.close()
  })

  it("adopts an unknown session only on session.created, never on session.updated", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Go", runtime: runtime("build") })
    stream.emit({ type: "session.updated", properties: { sessionID: "ses_evicted", info: { id: "ses_evicted", parentID: threadId } } })
    stream.emit(askFrom("ses_evicted", "per_evicted"))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events.filter((event) => event.type === "approval-requested")).toEqual([])
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled()
    await adapter.close()
  })

  it("drops a refusal that fails after its thread was unloaded, instead of retrying it on the reloaded thread", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Go", runtime: runtime("build") })
    stream.emit({ type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: threadId } } })
    stream.emit(askFrom("ses_child", "per_child"))
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "approval-requested", requestId: 1 })))
    const settle = deferred<never>()
    client.postSessionIdPermissionsPermissionId.mockReturnValueOnce(settle.promise)

    await adapter.stopThread(threadId)
    settle.resolve(Promise.reject(new Error("provider busy")))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await adapter.resumeThread({ threadId, cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Again", runtime: runtime("build") })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1)
    await adapter.close()
  })

  it("remembers a deletion it saw before the creation, so the child is never adopted", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Go", runtime: runtime("build") })
    stream.emit({ type: "session.deleted", properties: { info: { id: "ses_late", parentID: threadId } } })
    stream.emit({ type: "session.created", properties: { sessionID: "ses_late", info: { id: "ses_late", parentID: threadId } } })
    stream.emit(askFrom("ses_late", "per_late"))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events.filter((event) => event.type === "approval-requested")).toEqual([])
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled()
    await adapter.close()
  })

  it("drops a refusal that fails after its child was deleted, even while the thread stays loaded", async () => {
    const settle = deferred<{ data: boolean }>()
    const { adapter, client, stream, threadId } = await childAskedInFirstTurn((client) => {
      client.postSessionIdPermissionsPermissionId.mockReturnValueOnce(settle.promise)
    })
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1))

    stream.emit({ type: "session.deleted", properties: { info: { id: "ses_child", parentID: threadId } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    settle.resolve(Promise.reject(new Error("provider busy")))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1)
    await adapter.close()
  })

  it("does not retry an old refusal against a new child that reused the id after a tombstone burst", async () => {
    const settle = deferred<{ data: boolean }>()
    const { adapter, client, events, stream, threadId } = await childAskedInFirstTurn((client) => {
      client.postSessionIdPermissionsPermissionId.mockReturnValueOnce(settle.promise)
    })
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1))
    stream.emit({ type: "session.deleted", properties: { info: { id: "ses_child", parentID: threadId } } })
    for (let index = 0; index < 1_024; index += 1) {
      stream.emit({ type: "session.deleted", properties: { info: { id: `ses_burst_${index}`, parentID: threadId } } })
    }
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    stream.emit({ type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: threadId } } })
    stream.emit(askFrom("ses_child", "per_new"))
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "approval-requested", requestId: 2 })))

    settle.resolve(Promise.reject(new Error("provider busy")))
    await new Promise((resolve) => setTimeout(resolve, 20))
    finishRun(stream, threadId, "turn-2")
    await waitForDaemon(() => expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const oldRefusals = (client.postSessionIdPermissionsPermissionId.mock.calls as unknown as Array<[{ path: { permissionID: string } }]>).filter(
      ([input]) => input.path.permissionID === "per_child",
    )
    expect(oldRefusals).toHaveLength(1)
    await adapter.close()
  })

  it("forgets a deleted child without ever adopting it again", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Go", runtime: runtime("build") })
    stream.emit({ type: "session.created", properties: { sessionID: "ses_gone", info: { id: "ses_gone", parentID: threadId } } })
    stream.emit({ type: "session.deleted", properties: { info: { id: "ses_gone", parentID: threadId } } })
    stream.emit({ type: "session.updated", properties: { sessionID: "ses_gone", info: { id: "ses_gone", parentID: threadId } } })
    stream.emit(askFrom("ses_gone", "per_gone"))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events.filter((event) => event.type === "approval-requested")).toEqual([])
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled()
    await adapter.close()
  })

  it("refuses a child's pending approval when the parent turn ends, and ignores a later answer", async () => {
    const { adapter, client } = await childAskedInFirstTurn()

    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "ses_child", permissionID: "per_child" }, body: { response: "reject" } }),
    ))
    // The request is no longer waiting, so the answer says it reached
    // nothing (ruling Q285).
    expect(() => adapter.resolveApproval(1, "allow-once")).toThrow(ApprovalRequestNotPendingError)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "ses_child", permissionID: "per_child" }, body: { response: "once" } }),
    )
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1)
    await adapter.close()
  })

  it("keeps the parent's own pending approval answerable after its turn ends", async () => {
    const { client, factory, stream } = harness()
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Go", runtime: runtime("build") })
    stream.emit({
      type: "permission.asked",
      properties: { id: "per_parent", sessionID: threadId, permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, always: [] },
    })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "approval-requested", requestId: 1 })))
    finishRun(stream, threadId, "turn-1")
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "turn-completed" })))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled()
    adapter.resolveApproval(1, "deny")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: threadId, permissionID: "per_parent" }, body: { response: "reject" } }),
    ))
    await adapter.close()
  })

  it("does not attach a child's late events to the parent's next turn", async () => {
    const { adapter, client, events, stream, threadId, child } = await childAskedInFirstTurn()
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })

    stream.emit({ type: "session.updated", properties: { sessionID: child, info: { id: child, parentID: threadId, directory: "/worktree" } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_late", sessionID: child, role: "assistant", parentID: "child-user" } } })
    stream.emit({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: child,
          messageID: "msg_late",
          callID: "call_late",
          tool: "bash",
          state: { status: "completed", input: { command: "echo late" }, output: "" },
        },
      },
    })
    stream.emit({
      type: "permission.asked",
      properties: {
        id: "per_late",
        sessionID: child,
        permission: "bash",
        patterns: ["echo late"],
        metadata: { command: "echo late" },
        always: [],
        tool: { messageID: "msg_late", callID: "call_late" },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.filter((event) => JSON.stringify(event).includes("turn-2"))).toEqual([])
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: child, permissionID: "per_late" }, body: { response: "reject" } }),
    )
    await adapter.close()
  })

  it("refuses at once, with no card, a child's approval request that arrives after its turn ended", async () => {
    const { adapter, client, events, stream, child } = await childAskedInFirstTurn()

    stream.emit({
      type: "permission.asked",
      properties: {
        id: "per_after",
        sessionID: child,
        permission: "bash",
        patterns: ["echo after"],
        metadata: { command: "echo after" },
        always: [],
        tool: { messageID: "msg_after", callID: "call_after" },
      },
    })
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: child, permissionID: "per_after" }, body: { response: "reject" } }),
    ))
    expect(events.filter((event) => event.type === "approval-requested")).toHaveLength(1)
    await adapter.close()
  })

  it("ignores a session whose parent it does not hold", async () => {
    const { adapter, events, stream } = await buildTurn()

    stream.emit({ type: "session.created", properties: { sessionID: "ses_other", info: { id: "ses_other", parentID: "ses_unknown" } } })
    stream.emit({
      type: "permission.asked",
      properties: { id: "per_other", sessionID: "ses_other", permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, always: [] },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).not.toContainEqual(expect.objectContaining({ type: "approval-requested" }))
    await adapter.close()
  })
})

// Security review round 1 of #687: a permission name does not say which tool
// asks under it. A tool server's tool asks under `<server>_<tool>`, and a
// plugin's tool under whatever it names, so a tool that is not the server's
// own could take a name the embedded config allows. Before a session opens
// and before each prompt the adapter reads the directory's tool servers and
// tool ids, and refuses when one could take such a name, or when it cannot
// read them.
describe("tools that could take a name OpenCode's own tools ask under", () => {
  const adapters = [
    ["OpenCode", (factory: OpenCodeFactory) => new OpenCodeSdkAdapter(factory)],
    ["Kilo", (factory: OpenCodeFactory) => new KiloSdkAdapter(factory)],
  ] as const

  it.each([
    ["OpenCode", "plan", "plan_enter"],
    ["OpenCode", "Plan", "plan_enter"],
    ["OpenCode", "doom", "doom_loop"],
    ["Kilo", "board", "board_post"],
    ["Kilo", "kilo_memory", "kilo_memory_save"],
    ["Kilo", "semantic", "semantic_search"],
  ] as const)("refuses a %s session whose tool server %s could make %s", async (name, server, permission) => {
    const { client, factory } = harness()
    client.mcp.status.mockResolvedValue({ data: { docs: { status: "connected" }, [server]: { status: "connected" } } })
    const adapter = adapters.find(([candidate]) => candidate === name)![1](factory)
    const refusal = adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await expect(refusal).rejects.toThrow(`tool server named "${server}"`)
    await expect(refusal).rejects.toThrow(permission)
    expect(client.session.create).not.toHaveBeenCalled()
    await adapter.close()
  })

  it.each([
    ["a second glob", [...openCodeBuiltInToolIds, "glob"]],
    ["a list tool", [...openCodeBuiltInToolIds, "list"]],
    ["a plan_enter tool", [...openCodeBuiltInToolIds, "plan_enter"]],
  ] as const)("refuses a session with %s that is not OpenCode's own", async (_case, ids) => {
    const { client, factory } = harness()
    client.tool.ids.mockResolvedValue({ data: ids })
    const adapter = new OpenCodeSdkAdapter(factory)
    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })).rejects.toThrow("not one of its own")
    expect(client.session.create).not.toHaveBeenCalled()
    await adapter.close()
  })

  it("knows Kilo's own tools and what Kilo's embedded config allows", async () => {
    const { client, factory } = harness()
    client.tool.ids.mockResolvedValue({ data: [...kiloBuiltInToolIds] })
    const kilo = new KiloSdkAdapter(factory)
    await expect(kilo.startThread({ cwd: "/worktree", runtime: runtime("build") })).resolves.toBe("open-session")
    await kilo.close()

    const other = harness()
    other.client.tool.ids.mockResolvedValue({ data: [...kiloBuiltInToolIds, "semantic_search"] })
    const refused = new KiloSdkAdapter(other.factory)
    await expect(refused.startThread({ cwd: "/worktree", runtime: runtime("build") })).rejects.toThrow(`tool named "semantic_search"`)
    await refused.close()
  })

  // Security review round 4 of #687: on Windows the server matches rules in
  // any case, so a tool id that differs from one of its own, or from an
  // allowed permission, only in case takes that name there.
  it.each([
    ["win32", "READ", "refused"],
    ["win32", "Glob", "refused"],
    ["win32", "Plan_Enter", "refused"],
    ["darwin", "READ", "opened"],
    ["linux", "Glob", "opened"],
  ] as const)("on %s, treats a tool id %s by the server's case matching", async (platform, id, outcome) => {
    const { client, factory } = harness()
    client.tool.ids.mockResolvedValue({ data: [...openCodeBuiltInToolIds, id] })
    const adapter = new OpenCodeSdkAdapter(factory, undefined, undefined, { platform })
    const opened = adapter.startThread({ cwd: "/worktree", runtime: runtime("build") }).then(() => "opened", (error: Error) => {
      expect(error.message).toContain(`tool named "${id}"`)
      return "refused"
    })
    await expect(opened).resolves.toBe(outcome)
    await adapter.close()
  })

  // Security review round 5 of #687 (P3): the server compares in any case
  // with a RegExp "i" flag and no "u" flag, which reads "Σ" and "ς" as one
  // name, though their lower cases ("σ" and "ς") differ.
  it.each([
    ["win32", ["Σ", "ς"], "refused"],
    ["win32", ["ς", "Σ"], "refused"],
    ["win32", ["deploy", "DEPLOY"], "refused"],
    ["darwin", ["Σ", "ς"], "opened"],
    ["linux", ["deploy", "DEPLOY"], "opened"],
    // The server's matcher turns every backslash into a slash on both
    // sides, on every platform (packages/core/src/util/wildcard.ts, the
    // same file at opencode v1.18.32, v1.18.33 and kilo v7.8.1).
    ["darwin", ["a\\b", "a/b"], "refused"],
    ["linux", ["a/b", "a\\b"], "refused"],
    ["win32", ["a\\b", "A/B"], "refused"],
    ["linux", ["a\\b", "a_b"], "opened"],
  ] as const)("on %s, treats plugin tool ids %j as duplicates by the server's matcher", async (platform, ids, outcome) => {
    const { client, factory } = harness()
    client.tool.ids.mockResolvedValue({ data: [...openCodeBuiltInToolIds, ...ids] })
    const adapter = new OpenCodeSdkAdapter(factory, undefined, undefined, { platform })
    const opened = adapter.startThread({ cwd: "/worktree", runtime: runtime("build") }).then(() => "opened", (error: Error) => {
      expect(error.message).toContain(`tool named "${ids[1]}"`)
      return "refused"
    })
    await expect(opened).resolves.toBe(outcome)
    await adapter.close()
  })

  // An id the server's matcher reads as an allowed permission takes that
  // permission's rules unless it is exactly one of the server's own ids.
  it.each([
    ["darwin", "docs\\read", [], "refused"],
    ["linux", "docs\\read", ["docs/read"], "refused"],
    ["win32", "Docs\\Read", ["docs/read"], "refused"],
    ["linux", "docs/read", ["docs/read"], "opened"],
    ["win32", "docs\\read", ["docs\\read"], "opened"],
  ] as const)("on %s, treats tool id %j by the server's matcher against an allowed name", async (platform, id, own, outcome) => {
    const { client, factory } = harness()
    client.tool.ids.mockResolvedValue({ data: [...openCodeBuiltInToolIds, id] })
    const identity = {
      providerId: "opencode",
      providerName: "OpenCode",
      allowedPermissions: new Set([...openCodeAllowedPermissions, "docs/read"]),
      builtInToolIds: [...openCodeBuiltInToolIds, ...own],
    }
    const adapter = new OpenCodeSdkAdapter(factory, undefined, identity, { platform })
    const opened = adapter.startThread({ cwd: "/worktree", runtime: runtime("build") }).then(() => "opened", (error: Error) => {
      expect(error.message).toContain(`tool named "${id}"`)
      return "refused"
    })
    await expect(opened).resolves.toBe(outcome)
    await adapter.close()
  })

  it("opens a session whose tool servers and plugin tools take no such name", async () => {
    const { client, factory } = harness()
    client.mcp.status.mockResolvedValue({ data: { docs: { status: "connected" }, github: { status: "failed" } } })
    client.tool.ids.mockResolvedValue({ data: [...openCodeBuiltInToolIds, "deploy", "docs_publish"] })
    const adapter = new OpenCodeSdkAdapter(factory)
    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })).resolves.toBe("open-session")
    await adapter.close()
  })

  it.each([
    ["tool servers", "mcp"],
    ["tool ids", "tool"],
  ] as const)("refuses a session when its %s cannot be read", async (_case, part) => {
    const { client, factory } = harness()
    if (part === "mcp") client.mcp.status.mockRejectedValue(new Error("busy"))
    else client.tool.ids.mockRejectedValue(new Error("busy"))
    const adapter = new OpenCodeSdkAdapter(factory)
    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })).rejects.toThrow("could not read")
    await expect(adapter.resumeThread({ threadId: "open-session", cwd: "/worktree", runtime: runtime("build") })).rejects.toThrow("could not read")
    expect(client.session.create).not.toHaveBeenCalled()
    await adapter.close()
  })

  // Security review rounds 2 and 3 of #687: config this adapter does not see
  // (an agent or mode block of the person's, an organization or managed
  // config) could leave an agent a session runs allowing a tool that is not
  // the server's own. Each such agent's merged rules are read and checked by
  // shape: the last rule for every tool and every pattern must ask or deny,
  // and every allow after it must name one of the server's own permissions
  // literally. Any other allow, a wildcard or a named tool of the person's,
  // refuses the session.
  const ask = (permission: string, pattern = "*") => ({ permission, pattern, action: "ask" })
  const allow = (permission: string, pattern = "*") => ({ permission, pattern, action: "allow" })
  const agentsWith = (rules: unknown[], name = "build") => ({ data: [
    { name, mode: "primary", permission: rules },
    { name: "general", mode: "subagent", permission: [ask("*")] },
  ] })

  it.each([
    ["OpenCode", "build", [ask("*"), allow("*")], "does not ask before"],
    ["Kilo", "code", [ask("*"), allow("*")], "does not ask before"],
    ["OpenCode", "build", [ask("*"), allow("mcp_*")], `allows "mcp_*"`],
    ["OpenCode", "build", [ask("*"), allow("github_create_issue")], `allows "github_create_issue"`],
    ["OpenCode", "build", [ask("*"), allow("gl?b")], `allows "gl?b"`],
    ["OpenCode", "build", [ask("*"), { permission: "*", pattern: "src/*", action: "allow" }], `allows "*"`],
    ["OpenCode", "build", [allow("*")], "does not ask before"],
    ["OpenCode", "build", [ask("bash")], "does not ask before"],
    ["OpenCode", "build", [ask("*"), { permission: "glob", pattern: "*", action: "maybe" }], "rule Domovoi cannot read"],
    ["OpenCode", "general", [ask("*"), allow("docs_*")], `allows "docs_*"`],
  ] as const)("refuses a %s session whose %s agent has rules %j", async (name, agent, rules, message) => {
    const { client, factory } = harness()
    client.app.agents.mockResolvedValue(agent === "general"
      ? { data: [{ name: "build", mode: "primary", permission: [ask("*")] }, { name: "general", mode: "subagent", permission: rules }] }
      : agentsWith([...rules], agent))
    const adapter = adapters.find(([candidate]) => candidate === name)![1](factory)
    const refusal = adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await expect(refusal).rejects.toThrow(`${agent} agent`)
    await expect(refusal).rejects.toThrow(message)
    expect(client.session.create).not.toHaveBeenCalled()
    await adapter.close()
  })

  // Security review round 3 of #687 (P2): only the agents a session can reach
  // are checked: the primary agent it runs now, and every agent the task tool
  // can start from it, by the agent's effective mode and the primary's task
  // rule.
  it("checks only the primary agent selected and the subagents it can start", async () => {
    const opens = async (agents: unknown[], permissionMode: Runtime["permissionMode"] = "build") => {
      const { client, factory } = harness()
      client.app.agents.mockResolvedValue({ data: agents })
      const adapter = new OpenCodeSdkAdapter(factory)
      try {
        await adapter.startThread({ cwd: "/worktree", runtime: runtime(permissionMode) })
        return "opened"
      } catch (error) {
        return (error as Error).message
      } finally {
        await adapter.close()
      }
    }
    const build = { name: "build", mode: "primary", permission: [ask("*")] }
    // A general the person made primary cannot be started by the task tool.
    expect(await opens([build, { name: "general", mode: "primary", permission: [allow("*")] }])).toBe("opened")
    // A subagent of the person's that the task tool can start, with a card.
    expect(await opens([build, { name: "reviewer", mode: "subagent", permission: [ask("*"), allow("mcp_*")] }])).toContain("reviewer agent")
    expect(await opens([build, { name: "helper", mode: "all", permission: [ask("*"), allow("mcp_*")] }])).toContain("helper agent")
    // One the primary's task rule denies cannot be started.
    expect(await opens([
      { name: "build", mode: "primary", permission: [ask("*"), { permission: "task", pattern: "reviewer", action: "deny" }] },
      { name: "reviewer", mode: "subagent", permission: [ask("*"), allow("mcp_*")] },
    ])).toBe("opened")
    // Plan is checked when it is the agent the session runs.
    const plan = { name: "plan", mode: "primary", permission: [ask("*"), allow("mcp_*")] }
    expect(await opens([build, plan])).toBe("opened")
    expect(await opens([build, plan], "plan")).toContain("plan agent")
    // An agent the session would run that the server does not list refuses.
    expect(await opens([{ name: "general", mode: "subagent", permission: [ask("*")] }])).toContain("build agent")
  })

  it("lets the server's own permissions be allowed after the catch-all, and anything before it", async () => {
    const { client, factory } = harness()
    client.app.agents.mockResolvedValue(agentsWith([
      allow("*"), allow("mcp_*"), allow("github_create_issue"),
      ask("*"),
      allow("read"), { permission: "read", pattern: "*.env", action: "ask" }, allow("glob"), allow("task", "general"),
      allow("external_directory", "/tool-output/*"), allow("bash", "git log *"), allow("edit", ".opencode/plans/*.md"),
      ask("docs_*"), { permission: "secret_*", pattern: "*", action: "deny" },
    ]))
    const adapter = new OpenCodeSdkAdapter(factory)
    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })).resolves.toBe("open-session")
    await adapter.close()
  })

  it("refuses a session when the agents' rules cannot be read", async () => {
    const { client, factory } = harness()
    client.app.agents.mockRejectedValue(new Error("busy"))
    const adapter = new OpenCodeSdkAdapter(factory)
    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })).rejects.toThrow("could not read")
    await adapter.close()
  })

  // Security review round 2 of #687: a tool server added during a turn (the
  // server's POST /mcp) can register a tool named like an allowed built-in,
  // which then runs with no card, and the servers emit no event for an add.
  // The adapter watches the turn's tool calls: a call to a tool the catalog
  // does not hold, or a change in the directory's tool servers seen while the
  // turn calls tools, stops the turn. One call can run before the stop.
  async function turnWithTools(setup?: (client: ReturnType<typeof harness>["client"]) => void, id: () => string = () => "turn-1") {
    const { client, factory, stream } = harness()
    setup?.(client)
    const adapter = new OpenCodeSdkAdapter(factory, id)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Work", runtime: runtime("build") })
    stream.emit({ type: "message.updated", properties: { info: { id: "assistant-message", sessionID: threadId, role: "assistant", parentID: turnId } } })
    const call = (callID: string, tool: string, status = "pending") => stream.emit({
      type: "message.part.updated",
      properties: { part: { type: "tool", sessionID: threadId, messageID: "assistant-message", callID, tool, state: { status, input: {} } } },
    })
    // The turn's run ends: its reply completes, then the session goes idle.
    const finish = () => finishRun(stream, threadId, turnId, { id: "assistant-message" })
    return { adapter, client, events, stream, threadId, turnId, call, finish }
  }
  const turnEnd = (events: AgentEvent[]) => events.find((event) => event.type === "turn-completed")

  it("stops the turn when it calls a tool the catalog did not hold", async () => {
    const { adapter, client, events, call } = await turnWithTools()
    call("call-1", "plan_enter")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalled())
    await waitForDaemon(() => expect(turnEnd(events)).toMatchObject({ params: { turn: { status: "failed", error: expect.stringContaining("plan_enter") } } }))
    // The next prompt reads the catalog again and refuses the new server.
    client.mcp.status.mockResolvedValue({ data: { plan: { status: "connected" } } })
    await expect(adapter.startTurn({ threadId: "open-session", cwd: "/worktree", prompt: "Again", runtime: runtime("build") })).rejects.toThrow(`tool server named "plan"`)
    await adapter.close()
  })

  // Security review round 3 of #687: the run is aborted, and the abort
  // answered, before the Domovoi turn ends.
  it("ends the turn only once the abort is answered", async () => {
    let answer!: () => void
    const { adapter, client, events, call, finish } = await turnWithTools((setup) => {
      setup.session.abort.mockImplementation(() => new Promise((resolve) => { answer = () => resolve({ data: true }) }))
    })
    call("call-1", "plan_enter")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalled())
    // The run's own end, while the abort is under way, does not end the turn.
    finish()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnd(events)).toBeUndefined()
    answer()
    await waitForDaemon(() => expect(turnEnd(events)).toMatchObject({ params: { turn: { status: "failed" } } }))
    await adapter.close()
  })

  it("stops the turn when the directory's tool servers change while it calls tools", async () => {
    const { adapter, client, events, call } = await turnWithTools()
    client.mcp.status.mockResolvedValue({ data: { github: { status: "connected" } } })
    call("call-1", "bash")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalled())
    await waitForDaemon(() => expect(turnEnd(events)).toMatchObject({ params: { turn: { status: "failed", error: expect.stringContaining("github") } } }))
    await adapter.close()
  })

  // Security review round 3 of #687: a server listed as failed at the prompt
  // that connects during the turn exposes tools the prompt's read did not
  // see, under a name the catalog already holds; a change of status counts.
  it("stops the turn when a tool server's status changes while it calls tools", async () => {
    const { adapter, client, events, call } = await turnWithTools((setup) => {
      setup.mcp.status.mockResolvedValue({ data: { mcp: { status: "failed", error: "Connection closed" } } })
    })
    client.mcp.status.mockResolvedValue({ data: { mcp: { status: "connected" } } })
    call("call-1", "mcp_newly_available")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalled())
    await waitForDaemon(() => expect(turnEnd(events)).toMatchObject({ params: { turn: { status: "failed", error: expect.stringContaining("mcp") } } }))
    await adapter.close()
  })

  it("holds a turn's calls to the servers checked before the prompt, whatever a card read since", async () => {
    const { adapter, client, events, call, stream, threadId } = await turnWithTools()
    client.mcp.status.mockResolvedValue({ data: { github: { status: "connected" } } })
    stream.emit({
      type: "permission.asked",
      properties: { id: "p", sessionID: threadId, permission: "github_create_issue", patterns: ["*"], metadata: {}, always: ["*"], tool: { messageID: "msg_1", callID: "call_p" } },
    })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "approval-requested", toolServer: { name: "github" } })))
    call("call-2", "github_close_issue")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalled())
    await adapter.close()
  })

  // Security review round 3 of #687: call ids are not unique across provider
  // sessions, so a subagent's call that reuses one is still checked.
  // Security review round 4 of #687: another session's check in the same
  // directory must not change what a running turn is held to, and a check
  // that refuses publishes nothing.
  it("holds a turn to its own prompt's catalog when another session's check refuses a new server", async () => {
    const { adapter, client, call } = await turnWithTools()
    client.mcp.status.mockResolvedValue({ data: { plan: { status: "connected" } } })
    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })).rejects.toThrow(`tool server named "plan"`)
    call("call-1", "plan_enter")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalled())
    await adapter.close()
  })

  // Security review round 5 of #687: a steer runs its own check but does not
  // change what the running turn is held to, and neither does a prompt that
  // fails.
  it.each([
    ["is sent", false],
    ["is rejected", true],
  ] as const)("holds a turn to its first prompt's catalog when a steer that adds a server %s", async (_case, rejects) => {
    const { adapter, client, call, threadId } = await turnWithTools()
    client.mcp.status.mockResolvedValue({ data: { docs: { status: "connected" } } })
    if (rejects) client.session.promptAsync.mockRejectedValueOnce(new Error("busy"))
    const steer = adapter.steerTurn(threadId, "turn-1", "More")
    if (rejects) await expect(steer).rejects.toThrow()
    else await steer
    call("call-1", "docs_search")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalled())
    await adapter.close()
  })

  // Security review round 6 of #687 (P2): the server answers a prompt and
  // ends a run independently, so a turn can end while a steer is in flight.
  // The run the accepted steer starts is outside any Domovoi turn: Domovoi
  // aborts it, waits for the abort, and reports the steer as failed.
  it("stops a steer the server accepted after the turn ended, and reports it failed", async () => {
    let accept!: () => void
    let answerAbort!: () => void
    const { adapter, client, events, call, finish, threadId } = await turnWithTools()
    client.session.promptAsync.mockImplementationOnce(() => new Promise((resolve) => { accept = () => resolve({ data: undefined }) }))
    client.session.abort.mockImplementationOnce(() => new Promise((resolve) => { answerAbort = () => resolve({ data: true }) }))
    const steer = adapter.steerTurn(threadId, "turn-1", "More")
    let settled = false
    const outcome = steer.then(() => "sent", (error: Error) => error.message).finally(() => { settled = true })
    await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2))
    finish()
    await waitForDaemon(() => expect(turnEnd(events)).toMatchObject({ params: { turn: { status: "completed" } } }))
    accept()
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: threadId } })))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    answerAbort()
    expect(await outcome).toContain("turn ended while the steer was sent, so Domovoi stopped it")
    // The steer's run, if the abort has not reached it, still calls tools.
    client.session.abort.mockClear()
    call("call-9", "docs_search")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: threadId } })))
    await adapter.close()
  })

  it("aborts a run that calls a tool while the thread has no turn", async () => {
    const { adapter, client, events, call, finish, threadId } = await turnWithTools()
    finish()
    await waitForDaemon(() => expect(turnEnd(events)).toBeDefined())
    expect(client.session.abort).not.toHaveBeenCalled()
    call("call-9", "bash")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: threadId } })))
    await adapter.close()
  })

  it("aborts a run that asks for a tool's approval while the thread has no turn", async () => {
    const { adapter, client, events, stream, threadId, finish } = await turnWithTools()
    finish()
    await waitForDaemon(() => expect(turnEnd(events)).toBeDefined())
    stream.emit({
      type: "permission.asked",
      properties: { id: "p", sessionID: threadId, permission: "bash", patterns: ["ls"], metadata: {}, always: ["ls"], tool: { messageID: "msg_9", callID: "call_9" } },
    })
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: threadId } })))
    expect(events.filter((event) => event.type === "approval-requested")).toHaveLength(0)
    await adapter.close()
  })

  it.each([
    ["linked to a turn that ended", true],
    ["started while the thread had no turn", false],
  ] as const)("aborts a subagent %s that calls a tool", async (_case, linked) => {
    const { adapter, client, events, stream, threadId, finish } = await turnWithTools()
    if (linked) stream.emit({ type: "session.created", properties: { info: { id: "child-session", parentID: threadId } } })
    finish()
    await waitForDaemon(() => expect(turnEnd(events)).toBeDefined())
    if (!linked) stream.emit({ type: "session.created", properties: { info: { id: "child-session", parentID: threadId } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "child-message", sessionID: "child-session", role: "assistant", parentID: "child-user" } } })
    stream.emit({
      type: "message.part.updated",
      properties: { part: { type: "tool", sessionID: "child-session", messageID: "child-message", callID: "call-c", tool: "bash", state: { status: "running", input: {} } } },
    })
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "child-session" } })))
    await adapter.close()
  })

  // Security review round 7 of #687 (P2): an abort is recorded before it is
  // sent, its run's end (idle, error) is consumed through that record with or
  // without a turn, and a new prompt waits for a pending abort to settle.
  async function lateSteer() {
    let next = 0
    let accept!: () => void
    const answers: Array<(ok: boolean) => void> = []
    const setup = await turnWithTools((client) => {
      client.session.abort.mockImplementation(() => new Promise((resolve, reject) => {
        answers.push((ok) => (ok ? resolve({ data: true }) : reject(new Error("abort refused"))))
      }))
    }, () => `prompt-${++next}`)
    const { adapter, client, events, threadId } = setup
    client.session.promptAsync.mockImplementationOnce(() => new Promise((resolve) => { accept = () => resolve({ data: undefined }) }))
    const steer = adapter.steerTurn(threadId, "prompt-1", "More").then(() => "sent", (error: Error) => error.message)
    await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2))
    setup.finish()
    await waitForDaemon(() => expect(turnEnd(events)).toBeDefined())
    accept()
    await waitForDaemon(() => expect(answers).toHaveLength(1))
    const answer = (ok: boolean) => answers.shift()!(ok)
    return { ...setup, steer, answer, answers }
  }
  const turnEnds = (events: AgentEvent[], turnId: string) => events.filter((event) => event.type === "turn-completed" && event.params.turnId === turnId)

  // Round 8 (ruling Q287): the next turn's error counts only after the
  // turn's own prompt shows; before it, an error and idle are the aborted
  // steer's.
  it("does not end the next turn on the aborted steer's end, and fails it on its own error", async () => {
    const { adapter, events, stream, threadId, steer, answer } = await lateSteer()
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    answer(true)
    expect(await steer).toContain("turn ended while the steer was sent")
    const next = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnds(events, next)).toHaveLength(0)
    stream.emit({ type: "message.updated", properties: { info: { id: next, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "APIError", data: { message: "rate limited" } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(turnEnds(events, next)).toEqual([expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ status: "failed", error: expect.stringContaining("rate limited") }) }) })]))
    await adapter.close()
  })

  it("holds a turn started during a pending abort until the abort settles, and its idle does not end that turn", async () => {
    const { adapter, client, events, stream, threadId, steer, answer } = await lateSteer()
    const started = adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    answer(true)
    const next = await started
    expect(client.session.promptAsync).toHaveBeenCalledTimes(3)
    expect(await steer).toContain("turn ended while the steer was sent")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnds(events, next)).toHaveLength(0)
    finishRun(stream, threadId, next)
    await waitForDaemon(() => expect(turnEnds(events, next)).toHaveLength(1))
    await adapter.close()
  })

  it("fails a prompt that waited on an abort the server did not answer, with the stop's reason", async () => {
    const { adapter, client, threadId, steer, answer } = await lateSteer()
    const started = adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    answer(false)
    await expect(started).rejects.toThrow("turn ended while the steer was sent")
    expect(await steer).toContain("could not confirm")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
    await adapter.close()
  })

  // Security review round 7 of #687 (P2): a finished tool's report is a late
  // report, not a call, and a run has at most one abort outstanding.
  it("does not abort for a finished tool's late report, and joins an outstanding abort", async () => {
    const { adapter, client, events, stream, threadId, finish } = await turnWithTools((setup) => {
      setup.session.abort.mockImplementation(() => new Promise(() => {}))
    })
    stream.emit({ type: "session.created", properties: { info: { id: "child-session", parentID: threadId } } })
    finish()
    await waitForDaemon(() => expect(turnEnd(events)).toBeDefined())
    const report = (sessionID: string, messageID: string, callID: string, status: string) => stream.emit({
      type: "message.part.updated",
      properties: { part: { type: "tool", sessionID, messageID, callID, tool: "bash", state: { status, input: {} } } },
    })
    stream.emit({ type: "message.updated", properties: { info: { id: "child-message", sessionID: "child-session", role: "assistant", parentID: "child-user" } } })
    report(threadId, "assistant-message", "done-1", "completed")
    report(threadId, "assistant-message", "done-2", "error")
    report("child-session", "child-message", "done-3", "error")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.session.abort).not.toHaveBeenCalled()
    report(threadId, "assistant-message", "live-1", "running")
    report(threadId, "assistant-message", "live-2", "pending")
    report("child-session", "child-message", "live-3", "running")
    report("child-session", "child-message", "live-4", "running")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.session.abort.mock.calls.map((args: unknown[]) => (args[0] as { path: { id: string } }).path.id).sort()).toEqual(["child-session", threadId].sort())
    await adapter.close()
  })

  // Security review round 7 of #687 (P3): a stop already under way is shared,
  // so a late steer that meets it waits for its real answer.
  it("makes a late steer that meets a stop under way wait for that stop's answer", async () => {
    let next = 0
    let accept!: () => void
    let answer!: (ok: boolean) => void
    const { adapter, client, stream, threadId, events, finish } = await turnWithTools((setup) => {
      setup.session.abort.mockImplementation(() => new Promise((resolve, reject) => {
        answer = (ok) => (ok ? resolve({ data: true }) : reject(new Error("abort refused")))
      }))
    }, () => `prompt-${++next}`)
    client.session.promptAsync.mockImplementationOnce(() => new Promise((resolve) => { accept = () => resolve({ data: undefined }) }))
    let settled = false
    const steer = adapter.steerTurn(threadId, "prompt-1", "More").then(() => "sent", (error: Error) => error.message).finally(() => { settled = true })
    await waitForDaemon(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2))
    finish()
    await waitForDaemon(() => expect(turnEnd(events)).toBeDefined())
    const second = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    stream.emit({ type: "message.updated", properties: { info: { id: "reply-second", sessionID: threadId, role: "assistant", parentID: second } } })
    stream.emit({
      type: "message.part.updated",
      properties: { part: { type: "tool", sessionID: threadId, messageID: "reply-second", callID: "c", tool: "plan_enter", state: { status: "pending", input: {} } } },
    })
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledTimes(1))
    accept()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    answer(false)
    expect(await steer).toContain("could not confirm")
    await adapter.close()
  })

  // Security review round 7 of #687 (P3): an approval request from a
  // subagent outside its turn is refused and its run aborted.
  it.each([
    ["linked to a turn that ended", true],
    ["started while the thread had no turn", false],
  ] as const)("refuses and aborts a subagent %s that asks for approval", async (_case, linked) => {
    const { adapter, client, events, stream, threadId, finish } = await turnWithTools()
    if (linked) stream.emit({ type: "session.created", properties: { info: { id: "child-session", parentID: threadId } } })
    finish()
    await waitForDaemon(() => expect(turnEnd(events)).toBeDefined())
    if (!linked) stream.emit({ type: "session.created", properties: { info: { id: "child-session", parentID: threadId } } })
    stream.emit({
      type: "permission.asked",
      properties: { id: "p", sessionID: "child-session", permission: "bash", patterns: ["ls"], metadata: {}, always: ["ls"], tool: { messageID: "msg_c", callID: "call_c" } },
    })
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "child-session", permissionID: "p" }, body: { response: "reject" } })))
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "child-session" } })))
    expect(events.filter((event) => event.type === "approval-requested")).toHaveLength(0)
    await adapter.close()
  })

  // Security review round 8 of #687 (ruling Q287): an aborted run's end is
  // not counted. OpenCode 1.18.32/1.18.33 and Kilo 7.8.1 publish an error
  // and an idle from the processor's halt and another idle from the
  // runner's cancel. A turn the abort stops ends on the abort's answer, and
  // a later turn ends only on an idle after its own reply has completed.
  async function stoppedTurn() {
    let answer!: (ok: boolean) => void
    let next = 0
    const setup = await turnWithTools((client) => {
      client.session.abort.mockImplementation(() => new Promise((resolve, reject) => {
        answer = (ok) => (ok ? resolve({ data: true }) : reject(new Error("abort refused")))
      }))
    }, () => `prompt-${++next}`)
    setup.call("call-1", "plan_enter")
    await waitForDaemon(() => expect(setup.client.session.abort).toHaveBeenCalledTimes(1))
    const cancel = () => {
      setup.stream.emit({ type: "session.error", properties: { sessionID: setup.threadId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } })
      setup.stream.emit({ type: "session.idle", properties: { sessionID: setup.threadId } })
      setup.stream.emit({ type: "message.updated", properties: { info: { id: "assistant-message", sessionID: setup.threadId, role: "assistant", parentID: setup.turnId, time: { created: 1, completed: 2 }, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } } })
      setup.stream.emit({ type: "session.idle", properties: { sessionID: setup.threadId } })
    }
    return { ...setup, answer: (ok: boolean) => answer(ok), cancel }
  }

  it("does not end a stopping turn on its cancelled run's two idles before the abort is answered", async () => {
    const { adapter, events, turnId, answer, cancel } = await stoppedTurn()
    cancel()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnds(events, turnId)).toHaveLength(0)
    answer(true)
    await waitForDaemon(() => expect(turnEnds(events, turnId)).toEqual([expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ status: "failed", error: expect.stringContaining("plan_enter") }) }) })]))
    await adapter.close()
  })

  it("does not end a later turn on the stopped run's delayed second idle", async () => {
    const { adapter, events, stream, threadId, turnId, answer } = await stoppedTurn()
    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    answer(true)
    await waitForDaemon(() => expect(turnEnds(events, turnId)).toHaveLength(1))
    const later = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    // The cancelled run's failed reply and second idle, delivered late.
    stream.emit({ type: "message.updated", properties: { info: { id: "assistant-message", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 1, completed: 2 }, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    // The later turn's own prompt, and an idle before its reply completes.
    stream.emit({ type: "message.updated", properties: { info: { id: later, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(turnEnds(events, later)).toHaveLength(0)
    finishRun(stream, threadId, later)
    await waitForDaemon(() => expect(turnEnds(events, later)).toEqual([expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ status: "completed" }) }) })]))
    await adapter.close()
  })

  it("fails the stopped turn and a prompt waiting on its abort once the abort goes unanswered for ten seconds", async () => {
    const { adapter, client, events, call, threadId, turnId } = await turnWithTools((setup) => {
      setup.session.abort.mockImplementation(() => new Promise(() => {}))
    })
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let steer: Promise<string>
    let settled = false
    try {
      // The stop: a call to a tool the catalog did not hold.
      call("call-1", "plan_enter")
      for (let step = 0; step < 5; step += 1) await vi.advanceTimersByTimeAsync(1)
      expect(client.session.abort).toHaveBeenCalledTimes(1)
      steer = adapter.steerTurn(threadId, turnId, "More").then(() => "sent", (error: Error) => error.message).finally(() => { settled = true })
      await vi.advanceTimersByTimeAsync(9_000)
      expect(settled).toBe(false)
      expect(turnEnds(events, turnId)).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1_100)
    } finally {
      vi.useRealTimers()
    }
    const failure = await steer
    expect(failure).toContain("plan_enter")
    expect(failure).toContain("could not confirm")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(turnEnds(events, turnId)).toEqual([expect.objectContaining({ params: expect.objectContaining({ turn: expect.objectContaining({ status: "failed", error: expect.stringContaining("could not confirm") }) }) })])
    await adapter.close()
  })

  it("aborts nothing for a finished tool's first report in an active turn", async () => {
    const { adapter, client, events, call } = await turnWithTools()
    call("call-1", "plan_enter", "completed")
    call("call-2", "docs_search", "error")
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(client.session.abort).not.toHaveBeenCalled()
    expect(turnEnd(events)).toBeUndefined()
    await adapter.close()
  })

  it.each([
    ["an interrupt", "interrupt"],
    ["a thread stop", "stop"],
  ] as const)("joins %s to a stop under way instead of sending a second abort", async (_case, kind) => {
    const { adapter, client, events, threadId, turnId, answer } = await stoppedTurn()
    let settled = false
    const joined = (kind === "interrupt" ? adapter.interruptTurn(threadId, turnId) : adapter.stopThread(threadId)).finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    answer(true)
    await joined
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    expect(turnEnds(events, turnId)).toHaveLength(1)
    await adapter.close()
  })

  // A steer's reply names the steer as its parent, not the turn; its calls
  // are still the turn's and are held to the turn's catalog.
  it("holds a steer's own tool calls inside a live turn to the turn's catalog", async () => {
    let next = 0
    const { adapter, client, events, stream, threadId } = await turnWithTools(undefined, () => `prompt-${++next}`)
    expect(await adapter.steerTurn(threadId, "prompt-1", "More")).toEqual({ providerMessageId: "prompt-2" })
    stream.emit({ type: "message.updated", properties: { info: { id: "steer-reply", sessionID: threadId, role: "assistant", parentID: "prompt-2" } } })
    const call = (callID: string, tool: string) => stream.emit({
      type: "message.part.updated",
      properties: { part: { type: "tool", sessionID: threadId, messageID: "steer-reply", callID, tool, state: { status: "pending", input: {} } } },
    })
    call("call-1", "bash")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.session.abort).not.toHaveBeenCalled()
    expect(turnEnd(events)).toBeUndefined()
    call("call-2", "plan_enter")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalled())
    await waitForDaemon(() => expect(turnEnd(events)).toMatchObject({ params: { turnId: "prompt-1", turn: { status: "failed", error: expect.stringContaining("plan_enter") } } }))
    await adapter.close()
  })

  it("checks a subagent's call that reuses a call id the turn already used", async () => {
    const { adapter, client, call, stream, threadId } = await turnWithTools()
    call("shared-call", "bash")
    stream.emit({ type: "session.created", properties: { info: { id: "child-session", parentID: threadId } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "child-message", sessionID: "child-session", role: "assistant", parentID: "child-user" } } })
    stream.emit({
      type: "message.part.updated",
      properties: { part: { type: "tool", sessionID: "child-session", messageID: "child-message", callID: "shared-call", tool: "plan_enter", state: { status: "pending", input: {} } } },
    })
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalled())
    await adapter.close()
  })

  it("lets a turn call the tools the catalog holds", async () => {
    const { adapter, client, events, call } = await turnWithTools((setup) => {
      setup.mcp.status.mockResolvedValue({ data: { docs: { status: "connected" } } })
    })
    for (const [id, tool] of [["a", "bash"], ["b", "docs_search"], ["c", "list_mcp_resources"], ["d", "read_mcp_resource"], ["e", "invalid"]] as const) call(id, tool)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await waitForDaemon(() => expect(client.mcp.status.mock.calls.length).toBeGreaterThan(1))
    expect(client.session.abort).not.toHaveBeenCalled()
    expect(turnEnd(events)).toBeUndefined()
    await adapter.close()
  })

  it("checks again before each prompt", async () => {
    const { client, factory } = harness()
    const adapter = new OpenCodeSdkAdapter(factory)
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    client.mcp.status.mockResolvedValue({ data: { plan: { status: "connected" } } })
    await expect(adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Hello", runtime: runtime("build") })).rejects.toThrow(`tool server named "plan"`)
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    await adapter.close()
  })
})

// Security review round 9 of #687 (ruling Q294): a turn whose run ended with
// no event that ends it (compaction replies, a handler error after the last
// idle, an error before the prompt was recorded, an unfinished reply, or
// evidence held while an abort that then failed was pending) is settled from
// the server's own state: GET /session/status and GET /session/{id}/message,
// read two seconds after the idle, error or failed abort, and retried for up
// to thirty seconds. A busy session settles nothing.
describe("reconciling a turn with the server's own state", () => {
  type Message = { info: Record<string, unknown>; parts: unknown[] }
  const user = (id: string, created: number): Message => ({ info: { id, role: "user", time: { created } }, parts: [] })
  const reply = (id: string, parentID: string, created: number, end: { completed?: boolean; error?: string } = { completed: true }): Message => ({
    info: {
      id, role: "assistant", parentID,
      time: { created, ...(end.completed ? { completed: created + 1 } : {}) },
      ...(end.error ? { error: { name: "UnknownError", data: { message: end.error } } } : {}),
    },
    parts: [],
  })
  const turnEnds = (events: AgentEvent[], turnId: string) => events.filter((event) => event.type === "turn-completed" && event.params.turnId === turnId)
  const ended = (status: string, error?: string) => [expect.objectContaining({
    params: expect.objectContaining({ turn: expect.objectContaining({ status, ...(error === undefined ? {} : { error: expect.stringContaining(error) }) }) }),
  })]

  async function reconciledTurn(setup?: (client: ReturnType<typeof harness>["client"]) => void) {
    const { client, factory, server, stream } = harness()
    setup?.(client)
    let next = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `msg_${++next}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Work", runtime: runtime("build") })
    // Everything after setup runs on fake timers, so the reconcile delays,
    // retries and the abort bound are counted exactly.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const history = (messages: Message[]) => client.session.messages.mockResolvedValue({ data: messages })
    const idle = () => stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    const error = (message: string) => stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "UnknownError", data: { message } } } })
    const seen = () => stream.emit({ type: "message.updated", properties: { info: { id: turnId, sessionID: threadId, role: "user", time: { created: 10 } } } })
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)
    return { adapter, client, server, events, stream, threadId, turnId, history, idle, error, seen, tick }
  }
  afterEach(() => { vi.useRealTimers() })

  it("ends a turn whose replies answer compaction messages, not its prompt", async () => {
    const { adapter, events, stream, threadId, turnId, history, idle, seen, tick } = await reconciledTurn()
    seen()
    // Automatic compaction before the first reply: a generated user message,
    // its summary, a generated continuation and the reply to it.
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_6", sessionID: threadId, role: "assistant", parentID: "msg_5", time: { created: 12, completed: 13 } } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_8", sessionID: threadId, role: "assistant", parentID: "msg_7", time: { created: 14, completed: 15 } } } })
    idle()
    history([user(turnId, 10), user("msg_5", 11), reply("msg_6", "msg_5", 12), user("msg_7", 13), reply("msg_8", "msg_7", 14)])
    await tick(1_900)
    expect(turnEnds(events, turnId)).toEqual([])
    await tick(200)
    expect(turnEnds(events, turnId)).toEqual(ended("completed"))
    await adapter.close()
  })

  it("fails a turn whose handler error comes after the last idle", async () => {
    const { adapter, events, turnId, history, idle, error, seen, tick } = await reconciledTurn()
    seen()
    idle()
    error("storage busy")
    history([user(turnId, 10)])
    await tick(2_100)
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "storage busy"))
    await adapter.close()
  })

  it("fails a turn whose prompt the server never recorded, once that holds for the retry bound", async () => {
    const { adapter, events, turnId, history, idle, error, tick } = await reconciledTurn()
    error("could not resolve the prompt's files")
    idle()
    history([])
    await tick(10_000)
    expect(turnEnds(events, turnId)).toEqual([])
    await tick(25_000)
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "never recorded"))
    await adapter.close()
  })

  it("fails a turn whose recorded prompt has no reply and no error only once that holds for the retry bound", async () => {
    const { adapter, events, turnId, history, idle, seen, tick } = await reconciledTurn()
    seen()
    idle()
    history([user(turnId, 10)])
    await tick(10_000)
    expect(turnEnds(events, turnId)).toEqual([])
    await tick(25_000)
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "without a reply"))
    await adapter.close()
  })

  it("fails a turn whose reply the server left unfinished while idle", async () => {
    const { adapter, events, stream, threadId, turnId, history, idle, error, seen, tick } = await reconciledTurn()
    seen()
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_5", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 11 } } } })
    error("setup failed")
    idle()
    history([user(turnId, 10), reply("msg_5", turnId, 11, {})])
    await tick(2_100)
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "unfinished"))
    await adapter.close()
  })

  it.each([
    ["fails", true, 0],
    ["goes unanswered", false, 10_000],
  ] as const)("ends an interrupted turn from the server's state when its abort %s after the run finished", async (_case, refuse, wait) => {
    const { adapter, client, events, stream, threadId, turnId, history, idle, seen, tick } = await reconciledTurn()
    let reject!: (error: Error) => void
    client.session.abort.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    seen()
    const interrupt = adapter.interruptTurn(threadId, turnId).then(() => "answered", (failure: Error) => failure.message)
    await tick(0)
    // The run finishes on its own while the abort is pending.
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_5", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 11, completed: 12 } } } })
    idle()
    history([user(turnId, 10), reply("msg_5", turnId, 11)])
    await tick(100)
    expect(turnEnds(events, turnId)).toEqual([])
    if (refuse) reject(new Error("abort refused"))
    await tick(wait)
    expect(await interrupt).toContain("could not confirm")
    expect(turnEnds(events, turnId)).toEqual([])
    await tick(2_100)
    expect(turnEnds(events, turnId)).toEqual(ended("completed"))
    await adapter.close()
  })

  it("ends a turn held by a thread stop whose session deletion failed", async () => {
    const { adapter, client, events, stream, threadId, turnId, history, idle, seen, tick } = await reconciledTurn((setup) => {
      setup.session.delete.mockRejectedValueOnce(new Error("busy"))
    })
    let answer!: () => void
    client.session.abort.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({ data: true }) }))
    seen()
    const stop = adapter.stopThread(threadId).then(() => "stopped", (failure: Error) => failure.message)
    await tick(0)
    // The run finishes on its own while the stop's abort is pending.
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_5", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 11, completed: 12 } } } })
    idle()
    history([user(turnId, 10), reply("msg_5", turnId, 11)])
    await tick(100)
    expect(turnEnds(events, turnId)).toEqual([])
    answer()
    await tick(0)
    expect(await stop).toContain("busy")
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    await tick(2_100)
    expect(turnEnds(events, turnId)).toEqual(ended("completed"))
    await adapter.close()
  })

  it("never ends a new turn on an old run's idle while the server reports the session busy", async () => {
    const { adapter, client, events, threadId, turnId, history, idle, tick } = await reconciledTurn()
    client.session.status.mockResolvedValue({ data: { [threadId]: { type: "busy" } } })
    history([])
    idle()
    await tick(60_000)
    expect(client.session.status).toHaveBeenCalled()
    expect(turnEnds(events, turnId)).toEqual([])
    await adapter.close()
  })

  it("fails the turn, saying the run's end is unconfirmed, when the server cannot be read for the retry bound", async () => {
    const { adapter, client, events, turnId, idle, seen, tick } = await reconciledTurn()
    client.session.status.mockRejectedValue(new Error("connection refused"))
    seen()
    idle()
    await tick(20_000)
    expect(turnEnds(events, turnId)).toEqual([])
    await tick(30_000)
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "could not confirm how"))
    await adapter.close()
  })

  // Security review round 10 of #687 (ruling Q298, R10-1): the status and the
  // history are separate reads, so the session can turn busy between them.
  // An outcome is applied only when the status is idle again after the
  // history and nothing arrived for the session during the read.
  function heldHistory(client: ReturnType<typeof harness>["client"]) {
    let release!: (messages: Message[]) => void
    client.session.messages.mockImplementationOnce(() => new Promise((resolve) => { release = (messages) => resolve({ data: messages }) }))
    return (messages: Message[]) => release(messages)
  }

  it("applies no outcome when the run made progress while the history was read", async () => {
    const { adapter, client, events, stream, threadId, turnId, history, idle, seen, tick } = await reconciledTurn()
    seen()
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_5", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 11 } } } })
    idle()
    const release = heldHistory(client)
    await tick(2_100)
    expect(client.session.messages).toHaveBeenCalledTimes(1)
    // The run goes on while the history is read: busy, a reply, a tool.
    stream.emit({ type: "session.status", properties: { sessionID: threadId, status: { type: "busy" } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_6", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 12 } } } })
    stream.emit({ type: "message.part.updated", properties: { part: { type: "tool", sessionID: threadId, messageID: "msg_6", callID: "c1", tool: "bash", state: { status: "running", input: {} } } } })
    release([user(turnId, 10), reply("msg_5", turnId, 11, {})])
    await tick(100)
    expect(turnEnds(events, turnId)).toEqual([])
    // What the server holds once the run has really ended settles it.
    client.session.status.mockResolvedValue({ data: {} })
    history([user(turnId, 10), reply("msg_5", turnId, 11), reply("msg_6", turnId, 12)])
    await tick(5_000)
    expect(turnEnds(events, turnId)).toEqual(ended("completed"))
    await adapter.close()
  })

  it("applies no outcome when the status turns busy before the history comes back", async () => {
    const { adapter, client, events, threadId, turnId, idle, seen, tick } = await reconciledTurn()
    seen()
    idle()
    const release = heldHistory(client)
    await tick(2_100)
    client.session.status.mockResolvedValue({ data: { [threadId]: { type: "busy" } } })
    release([user(turnId, 10), reply("msg_5", turnId, 11, {})])
    await tick(100)
    expect(client.session.status).toHaveBeenCalledTimes(2)
    expect(turnEnds(events, turnId)).toEqual([])
    await adapter.close()
  })

  // R10-2: an abort that starts during the read holds the turn; the read's
  // outcome is dropped and the stop's reason survives.
  it("keeps a catalog stop that starts while the history is read, with its reason", async () => {
    const { adapter, client, events, stream, threadId, turnId, idle, seen, tick } = await reconciledTurn()
    let answer!: () => void
    client.session.abort.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({ data: true }) }))
    seen()
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_5", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 11 } } } })
    idle()
    const release = heldHistory(client)
    await tick(2_100)
    stream.emit({ type: "message.part.updated", properties: { part: { type: "tool", sessionID: threadId, messageID: "msg_5", callID: "c1", tool: "plan_enter", state: { status: "pending", input: {} } } } })
    await tick(10)
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    release([user(turnId, 10), user("msg_6", 11), reply("msg_7", "msg_6", 12)])
    await tick(100)
    expect(turnEnds(events, turnId)).toEqual([])
    answer()
    await tick(10)
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "plan_enter"))
    await adapter.close()
  })

  // An interrupt sends no event, so only the recheck of the abort holds it.
  it("keeps an interrupt that starts while the history is read, with its outcome", async () => {
    const { adapter, client, events, threadId, turnId, idle, seen, tick } = await reconciledTurn()
    let answer!: () => void
    client.session.abort.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({ data: true }) }))
    seen()
    idle()
    const release = heldHistory(client)
    await tick(2_100)
    const interrupt = adapter.interruptTurn(threadId, turnId)
    await tick(10)
    release([user(turnId, 10), reply("msg_5", turnId, 11)])
    await tick(100)
    expect(turnEnds(events, turnId)).toEqual([])
    answer()
    await interrupt
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "interrupted"))
    await adapter.close()
  })

  // R10-3: the servers order messages by (time.created, id) (opencode and
  // kilo session/message-v2.ts isAfter); so does the read.
  it("does not count an assistant from the prompt's millisecond whose id is earlier", async () => {
    const { adapter, events, turnId, history, idle, seen, tick } = await reconciledTurn()
    seen()
    idle()
    history([reply("msg_0", "msg_00", 10), user(turnId, 10)])
    await tick(2_100)
    expect(turnEnds(events, turnId)).toEqual([])
    await adapter.close()
  })

  it("picks the newest reply by time and id, whichever page it is on", async () => {
    const { adapter, client, events, turnId, idle, seen, tick } = await reconciledTurn()
    client.session.messages.mockImplementation(async (options?: unknown) => {
      const before = (options as { query?: { before?: string } } | undefined)?.query?.before
      if (before === undefined) {
        return { data: [reply("msg_9", turnId, 20, { completed: true, error: "context overflow" })], response: new Response(null, { headers: { "x-next-cursor": "older" } }) }
      }
      return { data: [user(turnId, 10), reply("msg_8", turnId, 20)] }
    })
    seen()
    idle()
    await tick(2_100)
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "context overflow"))
    await adapter.close()
  })

  // Security review round 11 of #687 (ruling Q302, R11-1): a thread-wide
  // stop (an approval answered elsewhere, a request Domovoi cannot answer, a
  // closed event stream) aborts the thread and its subagents. Until every
  // abort has settled and the stop has applied its own failure, nothing else
  // ends the turn: not the root abort's answer, not a read of the server.
  it.each([
    ["an approval answered elsewhere", "outside"],
    ["a request Domovoi cannot answer", "v2"],
    ["a closed event stream", "closed"],
  ] as const)("holds the turn through %s until its subagent's abort settles", async (_case, cause) => {
    const { adapter, client, events, stream, threadId, turnId, history, seen, tick } = await reconciledTurn()
    let answerChild!: () => void
    client.session.abort.mockImplementation((...args: unknown[]) => {
      const id = (args[0] as { path: { id: string } }).path.id
      return id === "ses_child"
        ? new Promise<{ data: boolean }>((resolve) => { answerChild = () => resolve({ data: true }) })
        : Promise.resolve({ data: true })
    })
    seen()
    stream.emit({ type: "session.created", properties: { info: { id: "ses_child", parentID: threadId } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_5", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 11 } } } })
    await tick(0)
    history([user(turnId, 10), reply("msg_5", turnId, 11)])
    if (cause === "outside") stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_elsewhere", reply: "once" } })
    if (cause === "v2") stream.emit({ type: "permission.v2.asked", properties: { sessionID: threadId, id: "per_v2" } })
    if (cause === "closed") stream.close()
    await tick(0)
    expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: "ses_child" } }))
    await tick(5_000)
    expect(turnEnds(events, turnId)).toEqual([])
    answerChild()
    await tick(10)
    const end = turnEnds(events, turnId)
    expect(end).toEqual(ended("failed"))
    const error = ((end[0] as unknown as { params: { turn: { error?: string } } }).params.turn.error) ?? ""
    if (cause === "outside") expect(end[0]).toMatchObject({ params: { failure: expect.anything() } })
    if (cause === "v2") expect(error).toContain("permission interface Domovoi does not answer")
    if (cause === "closed") expect(error).toContain("event stream")
    await adapter.close()
  })

  // Security review round 12 of #687 (ruling Q304). Aborts answered one by
  // one: each test sets which sessions' aborts wait for a manual answer.
  function manualAborts(client: ReturnType<typeof harness>["client"]) {
    const waiting = new Map<string, Array<(ok: boolean) => void>>()
    client.session.abort.mockImplementation((...args: unknown[]) => {
      const id = (args[0] as { path: { id: string } }).path.id
      return new Promise<{ data: boolean }>((resolve, reject) => {
        const answers = waiting.get(id) ?? []
        answers.push((ok) => (ok ? resolve({ data: true }) : reject(new Error("abort refused"))))
        waiting.set(id, answers)
      })
    })
    return {
      answer: (id: string, ok = true) => waiting.get(id)?.shift()?.(ok),
      pending: (id: string) => waiting.get(id)?.length ?? 0,
    }
  }
  const cause = (stream: EventStream, threadId: string, owner: "outside" | "v2" | "closed") => {
    if (owner === "outside") stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_elsewhere", reply: "once" } })
    if (owner === "v2") stream.emit({ type: "permission.v2.asked", properties: { sessionID: threadId, id: "per_v2" } })
    if (owner === "closed") stream.close()
  }

  // R12-1: a hold taken while the final readiness check already waits on a
  // root abort still holds the prompt.
  it.each([["outside"], ["v2"], ["closed"]] as const)("holds a steer whose last check is waiting on an abort when a %s stop begins", async (owner) => {
    const { adapter, client, events, stream, threadId, turnId, seen, tick } = await reconciledTurn()
    const aborts = manualAborts(client)
    seen()
    stream.emit({ type: "session.created", properties: { info: { id: "ses_child", parentID: threadId } } })
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_5", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 11 } } } })
    await tick(0)
    // The steer's catalog read is held, so its last check comes later. The
    // steer reads the worktree's instruction files from disk before that
    // read, which fake timers do not advance, so the test waits for the read
    // itself rather than a number of ticks. Nothing else runs between here
    // and the steer's read, so the held read is the steer's own.
    let readCatalog!: () => void
    const catalogRead = new Promise<void>((reached) => {
      client.mcp.status.mockImplementationOnce(() => new Promise((resolve) => {
        readCatalog = () => resolve({ data: {} })
        reached()
      }))
    })
    const steer = adapter.steerTurn(threadId, turnId, "More").then(() => "sent", (failure: Error) => failure.message)
    await catalogRead
    // A catalog stop: the root abort is pending when the steer's last check runs.
    stream.emit({ type: "message.part.updated", properties: { part: { type: "tool", sessionID: threadId, messageID: "msg_5", callID: "c1", tool: "plan_enter", state: { status: "pending", input: {} } } } })
    await tick(10)
    expect(aborts.pending(threadId)).toBe(1)
    readCatalog()
    await tick(10)
    // The thread-wide stop begins: it joins the root abort and aborts the child.
    cause(stream, threadId, owner)
    await tick(10)
    expect(aborts.pending("ses_child")).toBe(1)
    aborts.answer(threadId)
    await tick(10)
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    aborts.answer("ses_child")
    await tick(10)
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(await steer).not.toBe("sent")
    expect(turnEnds(events, turnId)).toHaveLength(1)
    await adapter.close()
  })

  // R12-2: overlapping thread-wide stops end the turn once, when the last
  // has settled, with the failure first in precedence: an approval answered
  // elsewhere, then a request Domovoi cannot answer, then a closed stream.
  it.each([
    ["over the same pending root abort", false],
    ["with a subagent adopted between them", true],
  ] as const)("ends a turn stopped twice with the approval answered elsewhere, %s", async (_case, adopt) => {
    const { adapter, client, events, stream, threadId, turnId, seen, tick } = await reconciledTurn()
    const aborts = manualAborts(client)
    seen()
    cause(stream, threadId, "v2")
    await tick(10)
    if (adopt) stream.emit({ type: "session.created", properties: { info: { id: "ses_child", parentID: threadId } } })
    await tick(0)
    cause(stream, threadId, "outside")
    await tick(10)
    expect(aborts.pending(threadId)).toBe(1)
    aborts.answer(threadId)
    await tick(10)
    if (adopt) {
      expect(turnEnds(events, turnId)).toEqual([])
      aborts.answer("ses_child")
      await tick(10)
    }
    const end = turnEnds(events, turnId)
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ params: { turn: { status: "failed" }, failure: expect.anything() } })
    await adapter.close()
  })

  // Security review round 13 of #687 (ruling Q306): a stop handler that
  // settles while another stop is still registered leaves the session in
  // place; the last to settle disposes of it, and the turn ends once with
  // the failure first in precedence.
  it("waits for a later approval stop when a closed stream's stop settles first", async () => {
    const { adapter, client, events, stream, threadId, turnId, seen, tick } = await reconciledTurn()
    const aborts = manualAborts(client)
    let refuse!: () => void
    client.postSessionIdPermissionsPermissionId.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = () => reject(new Error("refused")) }))
    seen()
    stream.emit({ type: "session.created", properties: { info: { id: "ses_child", parentID: threadId } } })
    stream.emit({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: threadId, permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, always: [], tool: { messageID: "msg_1", callID: "call_1" } },
    })
    await tick(10)
    adapter.resolveApproval(1, "allow-once")
    await tick(0)
    // The server reports the reply before it answers the request.
    stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_1", reply: "once" } })
    await tick(0)
    stream.close()
    await tick(10)
    aborts.answer(threadId)
    await tick(10)
    // The answer fails, so the reply was someone else's: a second stop.
    refuse()
    await tick(10)
    expect(aborts.pending(threadId)).toBe(1)
    aborts.answer("ses_child")
    await tick(10)
    expect(turnEnds(events, turnId)).toEqual([])
    aborts.answer(threadId)
    await tick(10)
    const end = turnEnds(events, turnId)
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ params: { turn: { status: "failed" }, failure: expect.anything() } })
    endsBeforeNotices(events, turnId)
    await adapter.close()
  })

  // Security review round 14 of #687 (ruling Q308): the daemon drops a
  // thread's turn on the incident and on a disconnect, so the turn's end must
  // reach it first, even when another stop deferred that end.
  function endsBeforeNotices(events: AgentEvent[], turnId: string) {
    const end = events.findIndex((event) => event.type === "turn-completed" && event.params.turnId === turnId)
    const notices = events.flatMap((event, index) => (event.type === "approval-answered-elsewhere" || event.type === "provider-disconnected" ? [index] : []))
    expect(end).toBeGreaterThanOrEqual(0)
    expect(events.some((event) => event.type === "approval-answered-elsewhere")).toBe(true)
    expect(events.some((event) => event.type === "provider-disconnected")).toBe(true)
    for (const index of notices) expect(end).toBeLessThan(index)
  }

  it("does not end the turn while a closed stream's stop and the server stop are still pending", async () => {
    const { adapter, client, server, events, stream, threadId, turnId, seen, tick } = await reconciledTurn()
    const aborts = manualAborts(client)
    let stopped!: (ok: boolean) => void
    server.stop.mockImplementation(() => new Promise<boolean>((resolve) => { stopped = resolve }))
    seen()
    cause(stream, threadId, "outside")
    await tick(10)
    stream.emit({ type: "session.created", properties: { info: { id: "ses_child", parentID: threadId } } })
    await tick(0)
    stream.close()
    await tick(10)
    expect(aborts.pending("ses_child")).toBe(1)
    aborts.answer(threadId)
    await tick(10)
    expect(turnEnds(events, turnId)).toEqual([])
    aborts.answer("ses_child")
    await tick(10)
    const end = turnEnds(events, turnId)
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ params: { turn: { status: "failed" }, failure: expect.anything() } })
    stopped(true)
    await tick(10)
    expect(turnEnds(events, turnId)).toHaveLength(1)
    endsBeforeNotices(events, turnId)
    await adapter.close()
  })

  // Security review round 17 of #687 (ruling Q313): requests a session
  // cannot answer must not starve a pending disconnect. A stop of a session
  // with no turn holds nothing, and a disconnect waits at most 30 seconds in
  // all, after which the server is stopped, every held turn ends and the
  // disconnect goes out.
  async function directories() {
    const { client, factory, server } = harness()
    const streams = new Map<string, EventStream>()
    client.event.subscribe.mockImplementation((async (...args: unknown[]) => {
      const directory = (args[0] as { query: { directory: string } }).query.directory
      const stream = streams.get(directory) ?? new EventStream()
      streams.set(directory, stream)
      return { stream }
    }) as never)
    let created = 0
    client.session.create.mockImplementation(async () => ({ data: { id: `ses_${++created}` } }))
    const aborts = manualAborts(client)
    let next = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `msg_${++next}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    let asked = 0
    return {
      adapter, client, server, events, aborts,
      open: (cwd: string) => adapter.startThread({ cwd, runtime: runtime("build") }),
      turn: (threadId: string, cwd: string) => adapter.startTurn({ threadId, cwd, prompt: "Go", runtime: runtime("build") }),
      stream: (cwd: string) => streams.get(cwd)!,
      v2: (cwd: string, threadId: string) => streams.get(cwd)!.emit({ type: "permission.v2.asked", properties: { sessionID: threadId, id: `per_v2_${++asked}` } }),
    }
  }
  const disconnects = (events: AgentEvent[], reason: string) => events.flatMap((event, index) => (event.type === "provider-disconnected" && event.reason === reason ? [index] : []))

  it("lets requests on sessions with no turn hold no disconnect", async () => {
    const { adapter, events, aborts, open, turn, stream, v2 } = await directories()
    const a = await open("/a")
    const c = await open("/c")
    const b = await open("/b")
    await turn(b, "/b")
    v2("/a", a)
    await waitForDaemon(() => expect(aborts.pending(a)).toBe(1))
    stream("/b").close()
    await waitForDaemon(() => expect(aborts.pending(b)).toBe(1))
    v2("/c", c)
    await waitForDaemon(() => expect(aborts.pending(c)).toBe(1))
    aborts.answer(b)
    await waitForDaemon(() => expect(disconnects(events, "OpenCode event stream connection closed")).toHaveLength(1))
    expect(aborts.pending(a)).toBe(1)
    expect(aborts.pending(c)).toBe(1)
    await adapter.close()
  })

  it("sends a disconnect within 30 seconds however many turns keep being stopped, after their ends, and stops the server", async () => {
    const { adapter, server, events, aborts, open, turn, stream, v2 } = await directories()
    server.stop.mockImplementation(() => new Promise<boolean>(() => {}))
    const sessions = { a: await open("/a"), c: await open("/c") }
    const b = await open("/b")
    await turn(sessions.a, "/a")
    await turn(sessions.c, "/c")
    await turn(b, "/b")
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)
    v2("/a", sessions.a)
    await tick(10)
    stream("/b").close()
    await tick(10)
    aborts.answer(b)
    await tick(10)
    // Each step starts a new turn on one session and stops it, then lets the
    // other session's stop end: some turn is always being stopped.
    let held: "a" | "c" = "a"
    for (let step = 0; step < 7; step += 1) {
      // Once the disconnect is out the server is stopped; nothing more runs.
      if (disconnects(events, "OpenCode event stream connection closed").length > 0) break
      const nextKey: "a" | "c" = held === "a" ? "c" : "a"
      const cwd = `/${nextKey}`
      if (step > 0) await turn(sessions[nextKey], cwd)
      v2(cwd, sessions[nextKey])
      await tick(10)
      aborts.answer(sessions[held])
      held = nextKey
      await tick(5_000)
      if (step < 5) expect(disconnects(events, "OpenCode event stream connection closed")).toEqual([])
    }
    const out = disconnects(events, "OpenCode event stream connection closed")
    expect(out).toHaveLength(1)
    const ends = events.flatMap((event, index) => (event.type === "turn-completed" ? [index] : []))
    expect(ends.length).toBeGreaterThan(0)
    for (const index of ends) expect(index).toBeLessThan(out[0]!)
    expect(server.stop).toHaveBeenCalled()
    // Round 18 (ruling Q314): the forced server stop sends no disconnect of
    // its own, even once its retirement bound has passed.
    await tick(25_000)
    expect(events.filter((event) => event.type === "provider-disconnected")).toHaveLength(1)
    await adapter.close()
  })

  // R12-3: a server stop that never answers does not hold a send for ever.
  it("rejects a held send when the adapter closes while the server stop is unanswered", async () => {
    const { adapter, client, server, stream, threadId, turnId, seen, tick } = await reconciledTurn()
    client.session.abort.mockRejectedValue(new Error("abort refused"))
    server.stop.mockImplementation(() => new Promise(() => {}))
    seen()
    cause(stream, threadId, "v2")
    const steer = adapter.steerTurn(threadId, turnId, "More").then(() => "sent", (failure: Error) => failure.message)
    await tick(10)
    expect(server.stop).toHaveBeenCalled()
    await adapter.close()
    await tick(100_000)
    expect(await steer).not.toBe("sent")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
  })

  it("keeps an unconfirmed server stop recorded, so no other server starts, once its bound has passed", async () => {
    const { adapter, client, server, stream, threadId, turnId, events, seen, tick } = await reconciledTurn()
    client.session.abort.mockRejectedValue(new Error("abort refused"))
    server.stop.mockImplementation(() => new Promise(() => {}))
    seen()
    cause(stream, threadId, "v2")
    await tick(30_000)
    expect(events).toContainEqual(expect.objectContaining({ type: "provider-disconnected", reason: expect.stringContaining("could not confirm that the server") }))
    expect(turnEnds(events, turnId)).toHaveLength(1)
    // The next connection stops the server again, within the same bound,
    // and is refused while that stop is unconfirmed.
    const connecting = adapter.connect().then(() => "connected", (failure: Error) => failure.message)
    await tick(25_000)
    expect(await connecting).toContain("could not confirm that the earlier")
    expect(server.stop).toHaveBeenCalledTimes(2)
    await adapter.close()
  })

  it("keeps the thread-wide stop's failure when it joins a catalog stop under way", async () => {
    const { adapter, client, events, stream, threadId, turnId, seen, tick } = await reconciledTurn()
    let answer!: () => void
    client.session.abort.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({ data: true }) }))
    seen()
    stream.emit({ type: "message.updated", properties: { info: { id: "msg_5", sessionID: threadId, role: "assistant", parentID: turnId, time: { created: 11 } } } })
    stream.emit({ type: "message.part.updated", properties: { part: { type: "tool", sessionID: threadId, messageID: "msg_5", callID: "c1", tool: "plan_enter", state: { status: "pending", input: {} } } } })
    await tick(10)
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    stream.emit({ type: "permission.v2.asked", properties: { sessionID: threadId, id: "per_v2" } })
    await tick(10)
    expect(client.session.abort).toHaveBeenCalledTimes(1)
    // A steer sent meanwhile waits for the stop, and then finds the turn over.
    const steer = adapter.steerTurn(threadId, turnId, "More").then(() => "sent", (failure: Error) => failure.message)
    answer()
    await tick(10)
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "permission interface Domovoi does not answer"))
    expect(await steer).toContain("no longer active")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    await adapter.close()
  })

  // R11-2: an abort that starts and settles while a read is in flight makes
  // that read stale; a fresh read after the abort decides.
  it("reads afresh after an abort that started and settled during the read", async () => {
    const { adapter, client, events, threadId, turnId, history, idle, seen, tick } = await reconciledTurn()
    client.session.abort.mockRejectedValueOnce(new Error("abort refused"))
    seen()
    idle()
    let release!: (messages: Message[]) => void
    client.session.messages.mockImplementationOnce(() => new Promise((resolve) => { release = (messages) => resolve({ data: messages }) }))
    await tick(2_100)
    const interrupt = adapter.interruptTurn(threadId, turnId).then(() => "answered", (failure: Error) => failure.message)
    expect(await interrupt).toContain("could not confirm")
    history([user(turnId, 10), reply("msg_5", turnId, 11, { completed: true, error: "stopped by the server" })])
    release([user(turnId, 10), reply("msg_5", turnId, 11)])
    await tick(100)
    expect(turnEnds(events, turnId)).toEqual([])
    await tick(2_100)
    expect(turnEnds(events, turnId)).toEqual(ended("failed", "stopped by the server"))
    await adapter.close()
  })

  // R11-3: events from a subagent whose turn has ended are refused or
  // dropped; they are not the current turn's activity.
  it("does not let an ended turn's subagent reset the current turn's retries", async () => {
    const { adapter, client, events, stream, threadId, turnId, idle, seen, tick } = await reconciledTurn()
    stream.emit({ type: "session.created", properties: { info: { id: "ses_old", parentID: threadId } } })
    seen()
    finishRun(stream, threadId, turnId)
    await tick(10)
    expect(turnEnds(events, turnId)).toHaveLength(1)
    const next = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    let sent = 0
    client.session.messages.mockImplementation(async () => {
      // An old subagent message arrives during every read.
      stream.emit({ type: "message.updated", properties: { info: { id: `old_${++sent}`, sessionID: "ses_old", role: "assistant", parentID: "old-user" } } })
      await new Promise((resolve) => setTimeout(resolve, 1))
      return { data: [] }
    })
    idle()
    await tick(45_000)
    expect(sent).toBeGreaterThan(3)
    expect(turnEnds(events, next)).toEqual(ended("failed", "never recorded"))
    await adapter.close()
  })
})

describe("Kilo legacy repository configuration", () => {
  it.each([
    [".kilo/mcp.json"],
    [".kilocode/mcp.json"],
    [".kilocodemodes"],
  ])("refuses a Kilo session before Kilo can load the worktree's %s", async (file) => {
    const worktree = await mkdtemp(join(tmpdir(), "domovoi-kilo-legacy-"))
    scratchDirectories.push(worktree)
    await mkdir(join(worktree, file, ".."), { recursive: true })
    await writeFile(join(worktree, file), "{}\n")
    const { client, factory } = harness()
    const adapter = new KiloSdkAdapter(factory)

    await expect(adapter.startThread({ cwd: worktree, runtime: runtime("build") }))
      .rejects.toThrow(`Kilo would load ${file} from this worktree`)
    await expect(adapter.resumeThread({ threadId: "kilo-thread", cwd: worktree, runtime: runtime("build") }))
      .rejects.toThrow(`Kilo would load ${file} from this worktree`)
    expect(client.session.create).not.toHaveBeenCalled()
    expect(client.session.get).not.toHaveBeenCalled()
    expect(client.event.subscribe).not.toHaveBeenCalled()
    await adapter.close()
  })

  it("refuses a Kilo turn once the worktree gains a legacy MCP file", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "domovoi-kilo-legacy-turn-"))
    scratchDirectories.push(worktree)
    const { client, factory } = harness()
    const adapter = new KiloSdkAdapter(factory)
    const threadId = await adapter.startThread({ cwd: worktree, runtime: runtime("build") })
    await mkdir(join(worktree, ".kilo"))
    await writeFile(join(worktree, ".kilo", "mcp.json"), "{}\n")

    await expect(adapter.startTurn({ threadId, cwd: worktree, prompt: "Hello", runtime: runtime("build") }))
      .rejects.toThrow("Kilo would load .kilo/mcp.json from this worktree")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    await adapter.close()
  })

  it("leaves OpenCode sessions in a worktree with Kilo legacy files alone", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "domovoi-opencode-kilo-files-"))
    scratchDirectories.push(worktree)
    await mkdir(join(worktree, ".kilo"))
    await writeFile(join(worktree, ".kilo", "mcp.json"), "{}\n")
    const { client, factory } = harness()
    const adapter = new OpenCodeSdkAdapter(factory)

    const threadId = await adapter.startThread({ cwd: worktree, runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: worktree, prompt: "Hello", runtime: runtime("build") })

    expect(client.session.promptAsync).toHaveBeenCalledOnce()
    await adapter.close()
  })
})

describe("event stream shapes", () => {
  it("keeps the stream open past an event that carries no properties", async () => {
    const { factory, stream } = harness()
    const adapter = new KiloSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Go", runtime: runtime("build") })

    stream.emit({ type: "sync" } as unknown as OpenCodeEvent)
    finishRun(stream, threadId, "turn-1")

    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed",
      params: expect.objectContaining({ turn: expect.objectContaining({ status: "completed" }) }),
    })))
    expect(events).not.toContainEqual(expect.objectContaining({ type: "provider-disconnected" }))
    await adapter.close()
  })
})

describe("SubagentRegistry", () => {
  it("drops a deleted child's record and keeps only a bounded tombstone, so it is never adopted again", () => {
    const registry = new SubagentRegistry(2)
    registry.link("child-a", { threadId: "thread", turnId: "turn-1" })
    registry.neverLink("child-b", "thread")
    expect(registry.size).toBe(2)

    registry.delete("child-a")
    registry.delete("child-b")
    expect(registry.size).toBe(0)
    expect(registry.isKnown("child-a")).toBe(true)
    expect(registry.isKnown("child-b")).toBe(true)

    registry.link("child-c", { threadId: "thread", turnId: "turn-1" })
    registry.delete("child-c")
    expect(registry.isKnown("child-a")).toBe(false)
    expect(registry.isKnown("child-c")).toBe(true)
    expect(registry.tombstones).toBe(2)
  })

  it("forgets every record and tombstone of a thread when the thread is unloaded", () => {
    const registry = new SubagentRegistry(8)
    registry.link("child-a", { threadId: "thread", turnId: "turn-1" })
    registry.neverLink("child-b", "thread")
    registry.link("child-c", { threadId: "other", turnId: "turn-1" })
    registry.forgetThread("thread")
    expect(registry.size).toBe(1)
    expect(registry.get("child-c")).toMatchObject({ threadId: "other", turnId: "turn-1" })
  })
})

describe("SubagentRegistry tombstones", () => {
  it("keeps the tombstone's thread when the same id is deleted again without a parent", () => {
    const registry = new SubagentRegistry(8)
    registry.delete("child", "thread")
    registry.delete("child")
    registry.forgetThread("thread")
    expect(registry.isKnown("child")).toBe(false)
  })


  it("moves a repeated deletion to the newest place, so a burst does not evict it", () => {
    const registry = new SubagentRegistry(2)
    registry.delete("old")
    registry.delete("recent")
    registry.delete("old")
    registry.delete("newest")
    expect(registry.isKnown("old")).toBe(true)
    expect(registry.isKnown("recent")).toBe(false)
    expect(registry.isKnown("newest")).toBe(true)
  })
})

// Q243 A with Q246 A and Q247 A, 2026-10-01: the embedded server's password
// sits in its startup environment, which any program it starts as the same
// user can read. A permission.replied that Domovoi did not send therefore
// stops the session. The only replies Domovoi treats as its own are the ones
// the server accepted from it, plus the rejections the server adds, after a
// rejection Domovoi sent, for the requests waiting then in that turn.
describe("approval replies Domovoi did not send", () => {
  const answeredElsewhere = {
    kind: "approval-answered-elsewhere",
    action: "review-changes",
    message: "An approval was answered outside Domovoi",
    retryable: false,
  }
  const adapters = [
    ["OpenCode", (factory: OpenCodeFactory) => new OpenCodeSdkAdapter(factory, () => "turn-1")],
    ["Kilo", (factory: OpenCodeFactory) => new KiloSdkAdapter(factory, () => "turn-1")],
  ] as const

  async function askedTurn(make: (factory: OpenCodeFactory) => OpenCodeSdkAdapter = adapters[0][1]) {
    const { client, factory, server, stream } = harness()
    const adapter = make(factory)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Build it", runtime: runtime("build") })
    const ask = (id: string, sessionID = threadId) => stream.emit({
      type: "permission.asked",
      properties: {
        id, sessionID, permission: "bash", patterns: ["pnpm test"], metadata: { command: "pnpm test" },
        always: ["pnpm *"], tool: { messageID: "msg_1", callID: `call_${id}` },
      },
    })
    const reply = (requestID: string, value: string, sessionID = threadId) => stream.emit({
      type: "permission.replied",
      properties: { sessionID, requestID, reply: value },
    })
    const approvals = () => events.filter((event) => event.type === "approval-requested")
    return { adapter, client, factory, server, events, stream, threadId, ask, reply, approvals }
  }

  const stopped = (events: AgentEvent[]) => events.filter((event) => event.type === "approval-answered-elsewhere")

  it.each([
    ...adapters.map(([name, make]) => [name, "once", make] as const),
    ...adapters.map(([name, make]) => [name, "always", make] as const),
  ])("stops a %s session when a %s reply Domovoi did not send arrives", async (_name, value, make) => {
    const { adapter, client, events, threadId, ask, reply, approvals } = await askedTurn(make)
    ask("per_1")
    ask("per_2")
    await waitForDaemon(() => expect(approvals()).toHaveLength(2))

    reply("per_1", value)

    await waitForDaemon(() => expect(stopped(events)).toEqual([{
      type: "approval-answered-elsewhere",
      threadId,
      turnId: "turn-1",
      permissionId: "per_1",
      requestId: 1,
      reply: value,
    }]))
    const completion = events.findIndex((event) => event.type === "turn-completed")
    expect(events[completion]).toEqual({
      type: "turn-completed",
      params: {
        threadId,
        turnId: "turn-1",
        turn: { id: "turn-1", status: "failed", error: "An approval was answered outside Domovoi" },
        failure: answeredElsewhere,
      },
    })
    expect(completion).toBeLessThan(events.findIndex((event) => event.type === "approval-answered-elsewhere"))
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: threadId },
      query: { directory: "/worktree" },
    })))
    // The request still waiting is refused; the answered one is not sent anything.
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: threadId, permissionID: "per_2" }, body: { response: "reject" } }),
    ))
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: threadId, permissionID: "per_1" } }),
    )
    // A later answer to either card sends nothing and says it reached
    // nothing (ruling Q285), and the thread is unloaded.
    expect(() => adapter.resolveApproval(1, "allow-once")).toThrow(ApprovalRequestNotPendingError)
    expect(() => adapter.resolveApproval(2, "allow-once")).toThrow(ApprovalRequestNotPendingError)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce()
    await expect(adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Again", runtime: runtime("build") }))
      .rejects.toThrow("is not loaded")
    await adapter.close()
  })

  it("reads the reply shape older servers send", async () => {
    const { adapter, events, stream, threadId, ask, approvals } = await askedTurn()
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    stream.emit({ type: "permission.replied", properties: { sessionID: threadId, permissionID: "per_1", response: "once" } })

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_1", reply: "once" }),
    ]))
    await adapter.close()
  })

  it("stops the session when the reply that arrives is not the one Domovoi sent", async () => {
    const { adapter, client, events, threadId, ask, reply, approvals } = await askedTurn()
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))
    adapter.resolveApproval(1, "deny")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())

    reply("per_1", "once")

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_1", reply: "once" }),
    ]))
    // Domovoi had answered that card, so no card it shows is the one answered.
    expect(stopped(events)[0]).not.toHaveProperty("requestId")
    await adapter.close()
  })

  // Codex review of #691 at a609034e, P2: the daemon names the card that was
  // answered, so the report carries the id the card's request had.
  it("names the request it had reported for the answered permission", async () => {
    const { adapter, events, threadId, ask, reply, approvals } = await askedTurn()
    ask("per_1")
    ask("per_2")
    await waitForDaemon(() => expect(approvals()).toHaveLength(2))
    const asked = approvals().find((event) => event.type === "approval-requested" && event.itemId === "call_per_2")
    expect(asked).toMatchObject({ requestId: 2 })

    reply("per_2", "always")

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_2", requestId: 2, reply: "always" }),
    ]))
    await adapter.close()
  })

  it.each(adapters)("keeps a %s session going on the reply Domovoi sent", async (_name, make) => {
    const { adapter, client, events, stream, threadId, ask, reply, approvals } = await askedTurn(make)
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))
    adapter.resolveApproval(1, "allow-once")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())

    reply("per_1", "once")
    finishRun(stream, threadId, "turn-1")

    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed",
      params: expect.objectContaining({ turn: { id: "turn-1", status: "completed" } }),
    })))
    expect(stopped(events)).toEqual([])
    expect(client.session.abort).not.toHaveBeenCalled()
    await adapter.close()
  })

  it("records its own reply before sending it, so a reply event that beats the answer is still its own", async () => {
    const { adapter, client, events, stream, threadId, ask, approvals } = await askedTurn()
    // The server publishes the reply before it answers the request that caused it.
    client.postSessionIdPermissionsPermissionId.mockImplementationOnce(async () => {
      stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_1", reply: "once" } })
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { data: true }
    })
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    adapter.resolveApproval(1, "allow-once")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())
    finishRun(stream, threadId, "turn-1")

    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "turn-completed" })))
    expect(stopped(events)).toEqual([])
    await adapter.close()
  })

  it("treats the rejections the server adds after Domovoi's own rejection as Domovoi's", async () => {
    const { adapter, client, events, stream, threadId, ask, reply, approvals } = await askedTurn()
    ask("per_1")
    ask("per_2")
    await waitForDaemon(() => expect(approvals()).toHaveLength(2))
    adapter.resolveApproval(1, "deny")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())

    // A rejection refuses every other request of the same session.
    reply("per_1", "reject")
    reply("per_2", "reject")
    finishRun(stream, threadId, "turn-1")

    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({ type: "turn-completed" })))
    expect(stopped(events)).toEqual([])
    await adapter.close()
  })

  // Codex review of #691, P3: the server's own rejections follow Domovoi's at
  // once, for the requests waiting then. The exception covers those requests
  // and ends with the turn.
  it("stops on a rejection in a later turn after Domovoi rejected one in an earlier turn", async () => {
    const { adapter, client, events, stream, threadId, ask, reply, approvals } = await askedTurn()
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))
    adapter.resolveApproval(1, "deny")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())
    reply("per_1", "reject")
    finishRun(stream, threadId, "turn-1")
    await waitForDaemon(() => expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(1))
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Next", runtime: runtime("build") })
    ask("per_3")
    await waitForDaemon(() => expect(approvals()).toHaveLength(2))

    reply("per_3", "reject")

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_3", reply: "reject" }),
    ]))
    await adapter.close()
  })

  it("stops on a rejection of a request that was not waiting when Domovoi sent its rejection", async () => {
    const { adapter, client, events, threadId, ask, reply, approvals } = await askedTurn()
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))
    adapter.resolveApproval(1, "deny")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())
    reply("per_1", "reject")

    reply("per_9", "reject")

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_9", reply: "reject" }),
    ]))
    await adapter.close()
  })

  it("stops the session on a rejection Domovoi did not send either", async () => {
    const { adapter, events, threadId, ask, reply, approvals } = await askedTurn()
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    reply("per_1", "reject")

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_1", reply: "reject" }),
    ]))
    await adapter.close()
  })

  it("stops the thread whose subagent's request was answered elsewhere", async () => {
    const { adapter, client, events, stream, threadId, ask, reply, approvals } = await askedTurn()
    stream.emit({ type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: threadId, directory: "/worktree" } } })
    ask("per_child", "ses_child")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    reply("per_child", "once", "ses_child")

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, turnId: "turn-1", permissionId: "per_child", requestId: 1, reply: "once" }),
    ]))
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: threadId } })))
    await adapter.close()
  })

  // Codex review of #691, P1: a record is an intent until the server accepts
  // the answer. The server takes one answer per request and refuses the rest,
  // so an answer it accepted is the one its reply event reports.
  it("treats a matching reply as external when Domovoi's own answer did not go through", async () => {
    const { adapter, client, events, threadId, ask, reply, approvals } = await askedTurn()
    client.postSessionIdPermissionsPermissionId.mockRejectedValueOnce(new Error("connection reset"))
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))
    adapter.resolveApproval(1, "allow-once")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))

    reply("per_1", "once")

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_1", reply: "once" }),
    ]))
    await adapter.close()
  })

  it("stops when the reply arrived while Domovoi's own answer was being refused", async () => {
    const { adapter, client, events, stream, threadId, ask, approvals } = await askedTurn()
    // Something else answered first: the server reports that reply, then
    // refuses Domovoi's answer because the request is gone.
    client.postSessionIdPermissionsPermissionId.mockImplementationOnce(async () => {
      stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_1", reply: "once" } })
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error("Permission request not found: per_1")
    })
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    adapter.resolveApproval(1, "allow-once")

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_1", reply: "once" }),
    ]))
    await adapter.close()
  })

  // Codex review of #691, round 2, P1: a POST that never answers is an
  // unknown outcome once its bound runs out, so a matching reply seen while
  // it was in flight is someone else's.
  it("stops when Domovoi's own answer never settles after a matching reply arrived", async () => {
    const { adapter, client, events, stream, threadId, ask, approvals } = await askedTurn()
    client.postSessionIdPermissionsPermissionId.mockImplementationOnce(() => {
      stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_1", reply: "once" } })
      return new Promise(() => {})
    })
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      adapter.resolveApproval(1, "allow-once")
      // vi.waitFor would move the fake clock, so the call is flushed instead.
      await vi.advanceTimersByTimeAsync(0)
      expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(permissionAnswerConfirmMs - 1)
      expect(stopped(events)).toEqual([])

      await vi.advanceTimersByTimeAsync(1)

      await waitForDaemon(() => expect(stopped(events)).toEqual([
        expect.objectContaining({ threadId, permissionId: "per_1", reply: "once" }),
      ]))
    } finally {
      vi.useRealTimers()
    }
    await adapter.close()
  })

  // Kilo ignores an approval of a skill shell batch or a sandbox escalation
  // unless the reply says a person gave it interactively, which the reply
  // Domovoi sends cannot say. Domovoi's approval of one never takes effect, so
  // an approval the server reports for one is never Domovoi's.
  it.each(["skillShell", "sandboxEscalation"])("never counts a Kilo approval of a %s request as its own", async (flag) => {
    const { adapter, client, events, stream, threadId, reply, approvals } = await askedTurn(adapters[1][1])
    stream.emit({
      type: "permission.asked",
      properties: {
        id: "per_1", sessionID: threadId, permission: "bash", patterns: ["pnpm test"],
        metadata: { command: "pnpm test", [flag]: true }, always: [], tool: { messageID: "msg_1", callID: "call_per_1" },
      },
    })
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))
    adapter.resolveApproval(1, "allow-once")
    await waitForDaemon(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))

    reply("per_1", "once")

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_1", reply: "once" }),
    ]))
    await adapter.close()
  })

  // Codex review of #691, P1: nothing is reported stopped until the provider
  // confirms it, and a stop it cannot confirm ends the whole server.
  it("keeps watching the thread until the provider confirms the run stopped", async () => {
    const { adapter, client, events, ask, reply, approvals } = await askedTurn()
    const abort = deferred<{ data: boolean }>()
    client.session.abort.mockImplementationOnce(() => abort.promise)
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    reply("per_1", "once")
    await waitForDaemon(() => expect(client.session.abort).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(stopped(events)).toEqual([])
    expect(events.some((event) => event.type === "turn-completed")).toBe(false)
    abort.resolve({ data: true })
    await waitForDaemon(() => expect(stopped(events)).toHaveLength(1))
    await adapter.close()
  })

  // Codex review of #691, P1: an always reply leaves an allow rule in the
  // server's memory for the whole directory. The server is restarted after
  // any reply made elsewhere, so nothing it left in place survives.
  it.each(adapters)("restarts the %s server after a reply made elsewhere", async (name, make) => {
    const { adapter, factory, server, events, ask, reply, approvals } = await askedTurn(make)
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    reply("per_1", "always")

    await waitForDaemon(() => expect(server.stop).toHaveBeenCalledOnce())
    await waitForDaemon(() => expect(events).toContainEqual({
      type: "provider-disconnected",
      reason: `Domovoi restarted the ${name} server because an approval was answered outside Domovoi, so no approval it kept stays in place`,
    }))
    expect(events.findIndex((event) => event.type === "approval-answered-elsewhere"))
      .toBeLessThan(events.findIndex((event) => event.type === "provider-disconnected"))
    await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    expect(factory).toHaveBeenCalledTimes(2)
    await adapter.close()
  })

  it("aborts every subagent of the thread as well as the thread", async () => {
    const { adapter, client, events, stream, threadId, ask, reply, approvals } = await askedTurn()
    stream.emit({ type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: threadId, directory: "/worktree" } } })
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    reply("per_1", "once")

    await waitForDaemon(() => expect(stopped(events)).toHaveLength(1))
    const aborted = (client.session.abort.mock.calls as unknown as Array<[{ path: { id: string } }]>)
      .map(([options]) => options.path.id)
    expect(aborted.sort()).toEqual([threadId, "ses_child"].sort())
    await adapter.close()
  })

  it("stops the whole server when it cannot confirm the run stopped, and says so", async () => {
    const { adapter, client, server, events, threadId, ask, reply, approvals } = await askedTurn()
    client.session.abort.mockRejectedValueOnce(new Error("socket hang up"))
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    reply("per_1", "once")

    await waitForDaemon(() => expect(server.stop).toHaveBeenCalledOnce())
    await waitForDaemon(() => expect(events).toContainEqual({
      type: "provider-disconnected",
      reason: "Domovoi stopped the OpenCode server because it could not confirm that a session it stopped had stopped",
    }))
    expect(stopped(events)).toEqual([expect.objectContaining({ threadId, permissionId: "per_1" })])
    await adapter.close()
  })

  it("says so when it cannot confirm the server stopped either", async () => {
    const { adapter, client, server, events, ask, reply, approvals } = await askedTurn()
    client.session.abort.mockResolvedValueOnce({ error: { message: "busy" } } as never)
    server.stop.mockResolvedValueOnce(false)
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))

    reply("per_1", "once")

    await waitForDaemon(() => expect(events).toContainEqual({
      type: "provider-disconnected",
      reason: "Domovoi stopped the OpenCode server because it could not confirm that a session it stopped had stopped. "
        + "Domovoi could not confirm that the server and the programs it started have ended, so it starts no other "
        + "OpenCode server until it can. Each new message checks again",
    }))
    await adapter.close()
  })

  // Codex review of #691, round 2, P1: one stop is a barrier for the
  // provider. Nothing starts another server while it runs, and a server not
  // confirmed gone is kept, stopped again on each attempt, and blocks the next.
  it("starts no other server while the stopped one is still stopping", async () => {
    const { adapter, factory, server, events, ask, reply, approvals } = await askedTurn()
    const stopping = deferred<boolean>()
    server.stop.mockImplementationOnce(() => stopping.promise)
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))
    reply("per_1", "once")
    await waitForDaemon(() => expect(server.stop).toHaveBeenCalledOnce())

    const starting = adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(factory).toHaveBeenCalledOnce()

    stopping.resolve(true)
    await expect(starting).resolves.toBe("open-session")
    expect(factory).toHaveBeenCalledTimes(2)
    expect(events.filter((event) => event.type === "provider-disconnected")).toHaveLength(1)
    await adapter.close()
  })

  // Codex review of #691, rounds 3 and 4, P1 (Q266): on Windows a process can
  // leave the tree taskkill would find, so once a tree kill has failed the
  // stopped server stays unconfirmed, whether its root has exited or still
  // runs. It is never killed again, and no other server starts.
  it.each([
    ["after the root exits", true],
    ["while the root still runs", false],
  ])("starts no other Windows server once a tree kill failed, %s", async (_case, rootExits) => {
    const { client, stream } = harness()
    const roots: Array<EventEmitter & { stdout: PassThrough }> = []
    // A second tree kill would succeed and end the root.
    const killTree = vi.fn()
      .mockRejectedValueOnce(new Error("taskkill exited with status 1"))
      .mockImplementation(async () => { roots[0]!.emit("exit", 1, null) })
    const start = embeddedServerCommand("opencode", "opencode server listening", {
      platform: "win32",
      spawn: () => {
        const root = Object.assign(new EventEmitter(), {
          pid: 5000 + roots.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
        })
        roots.push(root)
        return root as unknown as ChildProcess
      },
      killTree,
    })
    const factory = vi.fn(async () => {
      const pending = start({ hostname: "127.0.0.1", port: 0, timeout: 10_000, environment: {} })
      roots.at(-1)!.stdout.write("opencode server listening on http://127.0.0.1:4096\n")
      return { client, server: await pending }
    }) satisfies OpenCodeFactory
    const adapter = new OpenCodeSdkAdapter(factory, () => "turn-1")
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Build it", runtime: runtime("build") })
    stream.emit({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: threadId, permission: "bash", patterns: ["pnpm test"], metadata: { command: "pnpm test" }, always: [], tool: { messageID: "msg_1", callID: "call_1" } },
    })
    await waitForDaemon(() => expect(events.some((event) => event.type === "approval-requested")).toBe(true))
    stream.emit({ type: "permission.replied", properties: { sessionID: threadId, requestID: "per_1", reply: "once" } })
    await waitForDaemon(() => expect(events.some((event) => event.type === "provider-disconnected")).toBe(true))
    expect(killTree).toHaveBeenCalledOnce()

    // The root exits, or runs on; either way what it started may still run.
    if (rootExits) roots[0]!.emit("exit", 0, null)

    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") }))
      .rejects.toThrow("so it starts no other OpenCode server")
    // Windows has process trees, not groups, and only a restart clears one
    // that cannot be confirmed.
    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") }))
      .rejects.toThrow("To continue sooner, end those programs (process tree 5000), then restart Domovoi.")
    expect(factory).toHaveBeenCalledOnce()
    expect(killTree).toHaveBeenCalledOnce()
    await adapter.close()
  })

  it("refuses another server while the stopped one may still run, and stops it again on each attempt", async () => {
    const { adapter, factory, server, ask, reply, approvals } = await askedTurn()
    server.stop.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    ask("per_1")
    await waitForDaemon(() => expect(approvals()).toHaveLength(1))
    reply("per_1", "once")
    await waitForDaemon(() => expect(server.stop).toHaveBeenCalledOnce())

    const refusal = "Domovoi could not confirm that the earlier OpenCode server and the programs it started have ended, "
      + "so it starts no other OpenCode server. Each new message checks again. To continue sooner, end those programs "
      + "(process group 4242), then restart Domovoi."
    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })).rejects.toThrow(refusal)
    expect(server.stop).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledOnce()

    await expect(adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })).resolves.toBe("open-session")
    expect(server.stop).toHaveBeenCalledTimes(3)
    expect(factory).toHaveBeenCalledTimes(2)
    await adapter.close()
  })

  it("aborts the runs of a directory whose event stream closed before it lets them go", async () => {
    const { adapter, client, server, events, stream, threadId } = await askedTurn()

    stream.close()

    await waitForDaemon(() => expect(events).toContainEqual({
      type: "provider-disconnected", reason: "OpenCode event stream connection closed",
    }))
    expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: threadId } }))
    expect(server.stop).not.toHaveBeenCalled()
    await adapter.close()
  })

  it("stops the server when a run in a directory whose event stream closed cannot be aborted", async () => {
    const { adapter, client, server, events, stream } = await askedTurn()
    client.session.abort.mockRejectedValueOnce(new Error("connect ECONNREFUSED"))

    stream.close()

    await waitForDaemon(() => expect(server.stop).toHaveBeenCalledOnce())
    expect(events).toContainEqual({
      type: "provider-disconnected",
      reason: "Domovoi stopped the OpenCode server because it could not confirm that a session it stopped had stopped",
    })
    await adapter.close()
  })

  // Codex review of #691, P2: both servers also define permission.v2.asked
  // and permission.v2.replied. Domovoi answers neither, so every v2 reply is
  // someone else's, and a v2 request is one it cannot answer.
  it.each(adapters)("stops a %s session on a permission.v2.replied", async (_name, make) => {
    const { adapter, events, stream, threadId } = await askedTurn(make)

    stream.emit({ type: "permission.v2.replied", properties: { sessionID: threadId, requestID: "per_v2", reply: "once" } })

    await waitForDaemon(() => expect(stopped(events)).toEqual([
      expect.objectContaining({ threadId, permissionId: "per_v2", reply: "once" }),
    ]))
    await adapter.close()
  })

  it.each(adapters)("ends a %s turn that asks through permission.v2.asked, which Domovoi cannot answer", async (name, make) => {
    const { adapter, client, events, stream, threadId, approvals } = await askedTurn(make)

    stream.emit({
      type: "permission.v2.asked",
      properties: { id: "per_v2", sessionID: threadId, action: "bash", resources: ["pnpm test"], metadata: {} },
    })

    await waitForDaemon(() => expect(events).toContainEqual({
      type: "turn-completed",
      params: {
        threadId,
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: `${name} asked for an approval through a permission interface Domovoi does not answer, so Domovoi stopped the turn`,
        },
      },
    }))
    expect(client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: threadId } }))
    expect(approvals()).toEqual([])
    expect(stopped(events)).toEqual([])
    await adapter.close()
  })

  it("ignores a reply for a session it does not hold", async () => {
    const { adapter, client, events, reply } = await askedTurn()

    reply("per_elsewhere", "once", "ses_unknown")
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(stopped(events)).toEqual([])
    expect(client.session.abort).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === "turn-completed")).toBe(false)
    await adapter.close()
  })
})
