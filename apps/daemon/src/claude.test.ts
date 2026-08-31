import { describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import {
  ClaudeAgentSdkAdapter,
  claudePermissionFor,
  type ClaudeMessageId,
  type ClaudeQuery,
  type ClaudeQueryFactory,
  type ClaudeQueryOptions,
  type ClaudeSdkMessage,
  type ClaudeUserMessage,
} from "./claude.js"

class MessageStream implements AsyncIterable<ClaudeSdkMessage> {
  #messages: ClaudeSdkMessage[] = []
  #waiters: Array<(result: IteratorResult<ClaudeSdkMessage>) => void> = []
  #closed = false

  emit(message: ClaudeSdkMessage): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: message, done: false })
    else this.#messages.push(message)
  }

  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return {
      next: async () => {
        const message = this.#messages.shift()
        if (message) return { value: message, done: false }
        if (this.#closed) return { value: undefined, done: true }
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

class FakeQuery extends MessageStream implements ClaudeQuery {
  readonly initializationResult = vi.fn(async () => ({}))
  readonly supportedModels = vi.fn(async () => [{
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet 5",
    description: "Balanced coding model",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"] as const,
  }])
  readonly setModel = vi.fn(async () => {})
  readonly setPermissionMode = vi.fn(async () => {})
  readonly applyFlagSettings = vi.fn(async () => {})
  readonly interrupt = vi.fn(async () => {})
  override readonly close = vi.fn(() => this.closeStream())

  closeStream(): void {
    super.close()
  }
}

const runtime = (permissionMode: Runtime["permissionMode"], auto = false): Runtime => ({
  provider: "claude-code",
  model: "sonnet",
  reasoning: "high",
  permissionMode,
  auto,
})

function factoryHarness() {
  const calls: Array<{
    input: AsyncIterable<ClaudeUserMessage>
    options: ClaudeQueryOptions
    query: FakeQuery
  }> = []
  const factory: ClaudeQueryFactory = (input, options) => {
    const query = new FakeQuery()
    calls.push({ input, options, query })
    return query
  }
  return { calls, factory }
}

describe("claudePermissionFor", () => {
  it.each([
    [runtime("ask"), "default", false],
    [runtime("plan"), "plan", false],
    [runtime("build"), "default", false],
    [runtime("build", true), "default", false],
  ] as const)("maps Domovoi permissions to Claude enforcement", (input, mode, bypass) => {
    expect(claudePermissionFor(input)).toEqual({
      permissionMode: mode,
      allowDangerouslySkipPermissions: bypass,
    })
  })
})

describe("ClaudeAgentSdkAdapter", () => {
  it("declares pre-execution Build-auto enforcement", () => {
    const { factory } = factoryHarness()
    expect(new ClaudeAgentSdkAdapter(factory).permissionCapabilities).toEqual({
      buildAuto: "pre-execution",
    })
  })

  it("discovers models from the installed Claude runtime", async () => {
    const { calls, factory } = factoryHarness()
    const adapter = new ClaudeAgentSdkAdapter(factory)

    await expect(adapter.listModels()).resolves.toEqual([{
      provider: "claude-code",
      id: "sonnet",
      displayName: "Sonnet 5",
      description: "Balanced coding model",
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "high",
      isDefault: true,
    }])
    expect(calls[0]?.query.supportedModels).toHaveBeenCalledOnce()
    expect(calls[0]?.query.close).toHaveBeenCalledOnce()
    expect(calls[0]?.options.settingSources).toEqual([])
  })

  it("rejects malformed model metadata", async () => {
    const { calls, factory } = factoryHarness()
    const adapter = new ClaudeAgentSdkAdapter(factory)
    const listing = adapter.listModels()
    calls[0]!.query.supportedModels.mockResolvedValueOnce([{
      value: 7,
      displayName: "Sonnet 5",
      description: "Balanced coding model",
    }] as never)

    await expect(listing).rejects.toThrow("Claude model catalog returned invalid data")
  })

  it("starts a streaming session and emits turn text and completion", async () => {
    const { calls, factory } = factoryHarness()
    const turnId: ClaudeMessageId = "22222222-2222-4222-8222-222222222222"
    const ids: ClaudeMessageId[] = [
      "11111111-1111-4111-8111-111111111111",
      turnId,
    ]
    const adapter = new ClaudeAgentSdkAdapter(factory, () => ids.shift()!)
    const event = vi.fn()
    adapter.onEvent(event)

    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    expect(threadId).toBe("11111111-1111-4111-8111-111111111111")
    expect(calls[0]?.options).toMatchObject({
      cwd: "/worktree",
      sessionId: threadId,
      model: "sonnet",
      effort: "high",
      permissionMode: "default",
    })

    await expect(adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Run tests",
      runtime: runtime("build"),
    })).resolves.toBe(turnId)
    const input = await calls[0]!.input[Symbol.asyncIterator]().next()
    expect(input.value).toMatchObject({
      type: "user",
      message: { role: "user", content: "Run tests" },
      uuid: turnId,
      session_id: threadId,
    })

    calls[0]!.query.emit({
      type: "stream_event",
      session_id: threadId,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Tests pass." } },
    })
    calls[0]!.query.emit({ type: "result", subtype: "success", session_id: threadId, is_error: false })
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith({
      type: "text-delta",
      threadId,
      turnId,
      delta: "Tests pass.",
    }))
    expect(event).toHaveBeenCalledWith({
      type: "turn-completed",
      params: {
        threadId,
        turnId,
        turn: { id: turnId, status: "completed" },
      },
    })
    await adapter.close()
  })

  it("sends declared visual context as bounded image content", async () => {
    const { calls, factory } = factoryHarness()
    const adapter = new ClaudeAgentSdkAdapter(factory, () => "22222222-2222-4222-8222-222222222222")
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })

    await adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Review this annotation",
      runtime: runtime("build"),
      visualContexts: [{
        annotationId: "annotation-1",
        mimeType: "image/png",
        bytes: new Uint8Array([137, 80, 78, 71]),
      }],
    })
    const input = await calls[0]!.input[Symbol.asyncIterator]().next()
    expect(adapter.capabilities).toEqual({ vision: true })
    expect(input.value?.message.content).toEqual([
      { type: "text", text: "Review this annotation" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
      },
    ])
  })

  it("resumes with worktree context and routes approval decisions", async () => {
    const { calls, factory } = factoryHarness()
    const adapter = new ClaudeAgentSdkAdapter(factory, () => "22222222-2222-4222-8222-222222222222")
    const event = vi.fn()
    adapter.onEvent(event)

    await adapter.resumeThread({
      threadId: "22222222-2222-4222-8222-222222222222",
      cwd: "/restored-worktree",
      runtime: runtime("ask"),
    })
    expect(calls[0]?.options).toMatchObject({
      cwd: "/restored-worktree",
      resume: "22222222-2222-4222-8222-222222222222",
      permissionMode: "default",
    })

    const decision = calls[0]!.options.canUseTool!(
      "Bash",
      { command: "pnpm test" },
      {
        signal: new AbortController().signal,
        suggestions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "pnpm test" }],
          behavior: "allow",
          destination: "session",
        }],
        toolUseID: "tool-1",
        requestId: "claude-request-1",
        title: "Run project tests",
      },
    )
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "approval-requested",
      requestId: 1,
      threadId: "22222222-2222-4222-8222-222222222222",
      itemId: "tool-1",
      command: "pnpm test",
      cwd: "/restored-worktree",
      reason: "Run project tests",
    })))
    adapter.resolveApproval(1, "always-project")
    await expect(decision).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { command: "pnpm test" },
      updatedPermissions: [expect.objectContaining({ destination: "session" })],
    })
    await adapter.close()
  })

  it("translates Claude tool lifecycle into Domovoi command and file events", async () => {
    const { calls, factory } = factoryHarness()
    const ids: ClaudeMessageId[] = [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]
    const adapter = new ClaudeAgentSdkAdapter(factory, () => ids.shift()!)
    const event = vi.fn()
    adapter.onEvent(event)
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    await adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Update the preview",
      runtime: runtime("build"),
    })

    calls[0]!.query.emit({
      type: "assistant",
      session_id: threadId,
      message: {
        content: [
          { type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "pnpm test" } },
          { type: "tool_use", id: "tool-edit", name: "Edit", input: { file_path: "preview.html" } },
        ],
      },
    })
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "item",
      phase: "started",
      params: expect.objectContaining({
        item: expect.objectContaining({ id: "tool-bash", type: "commandExecution" }),
      }),
    })))
    expect(event).not.toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ item: expect.objectContaining({ type: "fileChange" }) }),
    }))

    calls[0]!.query.emit({
      type: "user",
      session_id: threadId,
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-bash", content: "Tests passed" }],
      },
      tool_use_result: { stdout: "Tests passed\n", stderr: "", interrupted: false },
    })
    calls[0]!.query.emit({
      type: "user",
      session_id: threadId,
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-edit", content: "Updated file" }],
      },
      tool_use_result: { filePath: "preview.html" },
    })
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "item",
      phase: "completed",
      params: expect.objectContaining({
        item: expect.objectContaining({
          id: "tool-bash",
          type: "commandExecution",
          status: "completed",
          aggregatedOutput: "Tests passed\n",
        }),
      }),
    })))
    expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "item",
      phase: "completed",
      params: expect.objectContaining({
        item: expect.objectContaining({
          id: "tool-edit",
          type: "fileChange",
          changes: [{ path: "preview.html" }],
        }),
      }),
    }))
    await adapter.close()
  })
})
