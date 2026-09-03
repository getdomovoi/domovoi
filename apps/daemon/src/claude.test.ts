import { resolve } from "node:path"

import { describe, expect, it, vi } from "vitest"

import type { Runtime } from "@getdomovoi/protocol"

import type { AgentEvent } from "./agents.js"
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
import { providerTurnCompletion } from "./provider-failures.js"

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
  readonly getContextUsage = vi.fn(async (): Promise<unknown> => {
    throw new Error("Context usage unavailable")
  })
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
    [runtime("ask"), "dontAsk", false],
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
  it("declares read-only Ask and pre-execution Build-auto enforcement", () => {
    const { factory } = factoryHarness()
    expect(new ClaudeAgentSdkAdapter(factory).permissionCapabilities).toEqual({
      ask: "read-only",
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
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(event).toHaveBeenCalledTimes(2)
  })

  it("reports current context from the Claude SDK after a turn", async () => {
    const { calls, factory } = factoryHarness()
    const ids: ClaudeMessageId[] = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]
    const adapter = new ClaudeAgentSdkAdapter(factory, () => ids.shift()!)
    const event = vi.fn()
    adapter.onEvent(event)
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Run tests",
      runtime: runtime("build"),
    })
    calls[0]!.query.getContextUsage.mockResolvedValueOnce({
      model: "claude-sonnet-5",
      totalTokens: 128_000,
      maxTokens: 180_000,
      rawMaxTokens: 200_000,
    })

    calls[0]!.query.emit({
      type: "result",
      subtype: "success",
      session_id: threadId,
      is_error: false,
      usage: { input_tokens: 120_000, output_tokens: 8_000 },
    })

    await vi.waitFor(() => expect(event).toHaveBeenCalledWith({
      type: "usage",
      threadId,
      turnId,
      usage: {
        inputTokens: 120_000,
        cachedInputTokens: 0,
        outputTokens: 8_000,
        reasoningTokens: 0,
        totalTokens: 128_000,
        contextTokens: 128_000,
        contextWindowTokens: 200_000,
        costSource: "unavailable",
      },
    }))
    expect(calls[0]!.query.getContextUsage).toHaveBeenCalledOnce()
    await adapter.close()
  })

  it("completes the turn when Claude context usage does not answer", async () => {
    vi.useFakeTimers()
    const { calls, factory } = factoryHarness()
    const ids: ClaudeMessageId[] = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]
    const adapter = new ClaudeAgentSdkAdapter(factory, () => ids.shift()!)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    try {
      const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
      const turnId = await adapter.startTurn({
        threadId,
        cwd: "/worktree",
        prompt: "Run tests",
        runtime: runtime("build"),
      })
      calls[0]!.query.getContextUsage.mockImplementationOnce(
        () => new Promise<unknown>(() => undefined),
      )

      calls[0]!.query.emit({
        type: "result",
        subtype: "success",
        session_id: threadId,
        is_error: false,
        usage: { input_tokens: 8, output_tokens: 2 },
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(events).toContainEqual({
        type: "usage",
        threadId,
        turnId,
        usage: {
          inputTokens: 8,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningTokens: 0,
          totalTokens: 10,
          costSource: "unavailable",
        },
      })
      expect(events).toContainEqual({
        type: "turn-completed",
        params: {
          threadId,
          turnId,
          turn: { id: turnId, status: "completed" },
        },
      })
      expect(events.map((event) => event.type)).toEqual(["usage", "turn-completed"])
    } finally {
      await adapter.close()
      vi.useRealTimers()
    }
  })

  it("fails the active turn and reopens the session when the Claude stream ends without a result", async () => {
    const { calls, factory } = factoryHarness()
    const ids: ClaudeMessageId[] = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]
    const adapter = new ClaudeAgentSdkAdapter(factory, () => ids.shift()!)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Run tests",
      runtime: runtime("build"),
    })

    calls[0]!.query.closeStream()
    await vi.waitFor(() => expect(events).toContainEqual({
      type: "turn-completed",
      params: {
        threadId,
        turnId,
        turn: {
          id: turnId,
          status: "failed",
          error: "Claude session connection closed before the turn completed",
        },
      },
    }))
    expect(events.map((event) => event.type)).toEqual(["turn-completed"])
    const completed = events.find(
      (event): event is Extract<AgentEvent, { type: "turn-completed" }> => event.type === "turn-completed",
    )
    expect(providerTurnCompletion(completed!.params)).toMatchObject({
      failed: true,
      failure: { kind: "transport", retryable: true },
    })

    await expect(adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Try again",
      runtime: runtime("build"),
    })).resolves.toBe("33333333-3333-4333-8333-333333333333")
    expect(calls).toHaveLength(2)
    expect(calls[1]!.options).toMatchObject({ cwd: "/worktree", resume: threadId })
    const input = await calls[1]!.input[Symbol.asyncIterator]().next()
    expect(input.value).toMatchObject({ message: { role: "user", content: "Try again" } })
    await adapter.close()
  })

  it("does not fail a turn when Domovoi stops the Claude thread", async () => {
    const { calls, factory } = factoryHarness()
    const ids: ClaudeMessageId[] = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]
    const adapter = new ClaudeAgentSdkAdapter(factory, () => ids.shift()!)
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
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls[0]!.query.close).toHaveBeenCalledOnce()
    expect(events).toEqual([])
  })

  it.each([
    ["Error: 401 authentication expired, please run /login", "authentication-expired"],
    ["Error: 429 rate limit exceeded", "rate-limit"],
    ["Error: insufficient_quota", "quota-exhausted"],
    ["Error: model claude-opus-9 not found", "model-unavailable"],
  ])("forwards the Claude failure text %s so the daemon can classify it", async (text, kind) => {
    const { calls, factory } = factoryHarness()
    const ids: ClaudeMessageId[] = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]
    const adapter = new ClaudeAgentSdkAdapter(factory, () => ids.shift()!)
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })
    const turnId = await adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Run tests",
      runtime: runtime("build"),
    })

    calls[0]!.query.emit({
      type: "result",
      subtype: "error_during_execution",
      session_id: threadId,
      is_error: true,
      errors: [text],
    })
    await vi.waitFor(() => expect(events).toContainEqual({
      type: "turn-completed",
      params: {
        threadId,
        turnId,
        turn: { id: turnId, status: "failed", error: `error_during_execution: ${text}` },
      },
    }))
    const completed = events.find(
      (event): event is Extract<AgentEvent, { type: "turn-completed" }> => event.type === "turn-completed",
    )
    expect(providerTurnCompletion(completed!.params)).toMatchObject({
      failed: true,
      failure: { kind },
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

  it("resumes with worktree context without installing provider-native approval rules", async () => {
    const { calls, factory } = factoryHarness()
    const adapter = new ClaudeAgentSdkAdapter(factory, () => "22222222-2222-4222-8222-222222222222")
    const event = vi.fn()
    adapter.onEvent(event)

    await adapter.resumeThread({
      threadId: "22222222-2222-4222-8222-222222222222",
      cwd: "/restored-worktree",
      runtime: runtime("build"),
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
    await expect(decision).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "pnpm test" },
    })
    await adapter.close()
  })

  it("forwards the edited file and blocked path on file tool approvals", async () => {
    const { calls, factory } = factoryHarness()
    const adapter = new ClaudeAgentSdkAdapter(factory, () => "22222222-2222-4222-8222-222222222222")
    const event = vi.fn()
    adapter.onEvent(event)

    await adapter.resumeThread({
      threadId: "22222222-2222-4222-8222-222222222222",
      cwd: "/worktree",
      runtime: runtime("build"),
    })

    const blocked = calls[0]!.options.canUseTool!(
      "Edit",
      { file_path: "/worktree/src/index.ts", old_string: "a", new_string: "b" },
      {
        signal: new AbortController().signal,
        blockedPath: "/worktree/.claude/settings.json",
        toolUseID: "tool-edit-blocked",
        requestId: "claude-request-2",
        title: "Edit a settings file",
      },
    )
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "approval-requested",
      requestId: 1,
      threadId: "22222222-2222-4222-8222-222222222222",
      itemId: "tool-edit-blocked",
      command: "Edit",
      cwd: "/worktree/.claude/settings.json",
      path: "/worktree/src/index.ts",
      blockedPath: "/worktree/.claude/settings.json",
      reason: "Edit a settings file",
    })))
    adapter.resolveApproval(1, "allow-once")
    await expect(blocked).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: "/worktree/src/index.ts" },
    })

    const relative = calls[0]!.options.canUseTool!(
      "Write",
      { file_path: "src/generated.ts", content: "export {}\n" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-write-relative",
        requestId: "claude-request-3",
        title: "Write a generated file",
      },
    )
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith(expect.objectContaining({
      type: "approval-requested",
      requestId: 2,
      threadId: "22222222-2222-4222-8222-222222222222",
      itemId: "tool-write-relative",
      command: "Write",
      cwd: "/worktree",
      // A relative tool path is resolved against the thread cwd, and resolve()
      // anchors a bare posix root to the current drive on Windows, so the
      // expectation has to be computed the same way rather than hardcoded.
      path: resolve("/worktree", "src/generated.ts"),
      reason: "Write a generated file",
    })))
    adapter.resolveApproval(2, "deny")
    await expect(relative).resolves.toMatchObject({ behavior: "deny" })
    await adapter.close()
  })

  it("isolates Ask from inherited approvals and exposes only read-only tools", async () => {
    const { calls, factory } = factoryHarness()
    const adapter = new ClaudeAgentSdkAdapter(factory)

    await adapter.resumeThread({
      threadId: "22222222-2222-4222-8222-222222222222",
      cwd: "/restored-worktree",
      runtime: runtime("ask"),
    })

    expect(calls[0]?.options).toMatchObject({
      permissionMode: "dontAsk",
      settingSources: [],
      tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    })
    expect(calls[0]?.options.disallowedTools).toEqual(expect.arrayContaining([
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "Task",
      "Skill",
      "mcp__*",
    ]))
    await expect(calls[0]!.options.canUseTool!(
      "Bash",
      { command: "touch escaped" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-denied",
        requestId: "request-denied",
      },
    )).resolves.toEqual({ behavior: "deny", message: "Ask mode is read-only" })
    await expect(calls[0]!.options.canUseTool!(
      "Read",
      { file_path: "README.md" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-read",
        requestId: "request-read",
      },
    )).resolves.toEqual({ behavior: "allow", updatedInput: { file_path: "README.md" } })
    await adapter.close()
  })

  it("reopens a Claude session when a turn crosses the Ask tool boundary", async () => {
    const { calls, factory } = factoryHarness()
    const ids: ClaudeMessageId[] = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]
    const adapter = new ClaudeAgentSdkAdapter(factory, () => ids.shift()!)
    const threadId = await adapter.startThread({ cwd: "/worktree", runtime: runtime("build") })

    await adapter.startTurn({
      threadId,
      cwd: "/worktree",
      prompt: "Inspect only",
      runtime: runtime("ask"),
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.query.close).toHaveBeenCalledOnce()
    expect(calls[1]!.options).toMatchObject({
      resume: threadId,
      permissionMode: "dontAsk",
      settingSources: [],
      tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
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
