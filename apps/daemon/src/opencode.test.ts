import { describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import { KiloSdkAdapter } from "./kilo.js"
import { domovoiKiloConfig } from "./kilo-runtime.js"
import {
  OpenCodeSdkAdapter,
  domovoiOpenCodeConfig,
  openCodeAgentFor,
  type OpenCodeClient,
  type OpenCodeEvent,
  type OpenCodeFactory,
} from "./opencode.js"

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
    [runtime("ask"), "build"],
    [runtime("plan"), "plan"],
    [runtime("build"), "build"],
    [runtime("build", true), "domovoi-auto"],
  ] as const)("maps Domovoi permissions to OpenCode agents", (input, agent) => {
    expect(openCodeAgentFor(input)).toBe(agent)
  })
})

describe("OpenCodeSdkAdapter", () => {
  it("declares pre-execution Build-auto enforcement", () => {
    const { factory } = harness()
    expect(new OpenCodeSdkAdapter(factory).permissionCapabilities).toEqual({
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
        info: { id: "assistant-message", sessionID: threadId, role: "assistant" },
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
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "approval-requested",
      requestId: 1,
      threadId,
      turnId: "turn-1",
      command: "pnpm test",
    })))
    adapter.resolveApproval(1, "always-project")
    await vi.waitFor(() => expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: threadId, permissionID: "permission-1" },
        body: { response: "always" },
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
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith({
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
    await vi.waitFor(() => expect(client.session.get).toHaveBeenCalledOnce())

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
