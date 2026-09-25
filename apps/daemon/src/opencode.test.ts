import { waitForDaemon } from "./test-wait-for.js"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import type { AgentEvent } from "./agents.js"
import { KiloSdkAdapter } from "./kilo.js"
import { domovoiKiloConfig } from "./kilo-runtime.js"
import {
  OpenCodeSdkAdapter,
  SubagentRegistry,
  domovoiOpenCodeConfig,
  openCodeAgentFor,
  openCodeMessageId,
  OpenCodeMessageIdsExhaustedError,
  openCodeMessageOrder,
  type OpenCodeClient,
  type OpenCodeEvent,
  type OpenCodeFactory,
} from "./opencode.js"
import { removeScratchDirectories } from "./test-scratch.js"

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
    },
    event: {
      subscribe: vi.fn(async () => ({ stream })),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
  } satisfies OpenCodeClient
  const server = { close: vi.fn() }
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

  it("discovers configured models without starting a model turn", async () => {
    const { client, factory, server } = harness()
    const adapter = new OpenCodeSdkAdapter(factory)

    await expect(adapter.listModels()).resolves.toEqual([{
      provider: "opencode",
      id: "anthropic/sonnet",
      displayName: "Anthropic / Claude Sonnet",
      description: "OpenCode model from Anthropic",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
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
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(events.some((event) => event.type === "turn-completed")).toBe(true))
    await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Second", runtime: runtime("build") })
    for (const info of [
      { id: "late", parentID: "turn-1" }, { id: "unassociated" },
    ]) stream.emit({ type: "message.updated", properties: { info: {
      ...info, sessionID: threadId, role: "assistant", tokens: { input: 10, output: 1 },
    } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(2))
    expect(events.filter((event) => event.type === "usage")).toEqual([
      expect.objectContaining({ turnId: "turn-1", source: expect.objectContaining({ id: "late" }) }),
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
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
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
    reopened.emit({ type: "session.idle", properties: { sessionID: threadId } })
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
  it("discovers Kilo models without starting an inference turn", async () => {
    const { client, factory, server } = harness()
    const adapter = new KiloSdkAdapter(factory)

    await expect(adapter.listModels()).resolves.toEqual([{
      provider: "kilo",
      id: "anthropic/sonnet",
      displayName: "Anthropic / Claude Sonnet",
      description: "Kilo model from Anthropic",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
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

describe("an interrupted turn's end that arrives late", () => {
  it("does not complete the turn sent after the interrupt", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const first = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    stream.emit({ type: "message.updated", properties: { info: { id: first, sessionID: threadId, role: "user" } } })
    await adapter.interruptTurn(threadId, first)
    const second = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Two", runtime: runtime("build") })

    // The server ends the aborted run before it takes the next prompt, so its
    // idle comes before the new turn's own user message.
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.filter((event) => event.type === "turn-completed")).toEqual([])

    stream.emit({ type: "message.updated", properties: { info: { id: second, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed",
      params: expect.objectContaining({ turnId: second, turn: expect.objectContaining({ status: "completed" }) }),
    })))
    await adapter.close()
  })

  // Only an interrupt arms the wait for the new turn's own messages. Without
  // one, the first idle or error ends the turn, even before any message.
  it("ends a turn on a session error that comes before its user message when nothing was interrupted", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })

    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "ProviderAuthError", data: { message: "no key" } } } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed",
      params: expect.objectContaining({ turnId, turn: expect.objectContaining({ status: "failed" }) }),
    })))
    await adapter.close()
  })

  it("waits for the new turn's messages only until the interrupted run's end has come", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const first = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    await adapter.interruptTurn(threadId, first)
    const second = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Two", runtime: runtime("build") })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const third = await adapter.interruptTurn(threadId, second).then(() =>
      adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Three", runtime: runtime("build") }))
    void third
    events.length = 0
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "UnknownError", data: { message: "boom" } } } })
    await waitForDaemon(() => expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(1))
    await adapter.close()
  })

  // A run that ends through the processor's halt publishes an error and then
  // sets the session idle. Both belong to the interrupted run.
  it("ignores both the error and the idle an interrupted run ends with", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const first = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    await adapter.interruptTurn(threadId, first)
    const second = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Two", runtime: runtime("build") })

    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "MessageAbortedError", data: { message: "aborted" } } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.filter((event) => event.type === "turn-completed")).toEqual([])

    stream.emit({ type: "message.updated", properties: { info: { id: second, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed",
      params: expect.objectContaining({ turnId: second, turn: expect.objectContaining({ status: "completed" }) }),
    })))
    await adapter.close()
  })

  // The error can end the interrupted turn while it still holds the slot. The
  // idle that follows still belongs to it and must not end the next turn.
  it("ignores the idle that follows an error which ended the interrupted turn itself", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const first = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    stream.emit({ type: "message.updated", properties: { info: { id: first, sessionID: threadId, role: "user" } } })
    await adapter.interruptTurn(threadId, first)

    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "MessageAbortedError", data: { message: "aborted" } } } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed",
      params: expect.objectContaining({ turnId: first, turn: expect.objectContaining({ status: "failed" }) }),
    })))
    const second = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Two", runtime: runtime("build") })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(1)

    stream.emit({ type: "message.updated", properties: { info: { id: second, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed",
      params: expect.objectContaining({ turnId: second, turn: expect.objectContaining({ status: "completed" }) }),
    })))
    expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(2)
    await adapter.close()
  })

  // A subagent's idle ends its task tool call. It is not the interrupted run's
  // end, so it must leave the interrupt record for the parent's own idle.
  it("keeps the interrupt record through a subagent's idle", async () => {
    const { factory, stream } = harness()
    let id = 0
    const adapter = new OpenCodeSdkAdapter(factory, () => `turn-${++id}`)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const first = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "One", runtime: runtime("build") })
    stream.emit({ type: "message.updated", properties: { info: { id: first, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: threadId, directory: "/worktree" } } })
    await adapter.interruptTurn(threadId, first)

    stream.emit({ type: "session.idle", properties: { sessionID: "ses_child" } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await adapter.startTurn({ threadId, cwd: "/worktree", prompt: "Two", runtime: runtime("build") })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events.filter((event) => event.type === "turn-completed")).toEqual([])

    stream.emit({ type: "message.updated", properties: { info: { id: second, sessionID: threadId, role: "user" } } })
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed",
      params: expect.objectContaining({ turnId: second, turn: expect.objectContaining({ status: "completed" }) }),
    })))
    expect(events.filter((event) => event.type === "turn-completed")).toHaveLength(1)
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
    expect(config.permission).toEqual({
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
    stream.emit({ type: "session.error", properties: { sessionID: threadId, error: { name: "UnknownError", data: { message: "parent failed" } } } })
    await waitForDaemon(() => expect(events).toContainEqual(expect.objectContaining({
      type: "turn-completed", params: expect.objectContaining({ turnId: "turn-1" }),
    })))
    return { adapter, client, events, stream, threadId, child }
  }

  const askFrom = (sessionID: string, id: string) => ({
    type: "permission.asked" as const,
    properties: { id, sessionID, permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, always: [] },
  })

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
    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled()
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
    adapter.resolveApproval(1, "allow-once")
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
    adapter.resolveApproval(1, "allow-once")
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
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
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
    adapter.resolveApproval(1, "allow-once")
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
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })
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
    stream.emit({ type: "session.idle", properties: { sessionID: threadId } })

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
