import { describe, expect, it } from "vitest"

import {
  auditEntrySchema,
  auditExportResultSchema,
  auditQueryPageSchema,
  auditQueryParamsSchema,
  demoWorkspace,
  helloParamsSchema,
  maximumJsonValueDepth,
  rpcMethods,
  rpcNotificationSchema,
  rpcRequestSchema,
  rpcResponseSchema,
  systemEmergencyStopResultSchema,
  systemEmergencyStoppedNotificationSchema,
  sessionEvidenceSchema,
  sessionHistoryCategorySchema,
  sessionHistoryPageSchema,
  sessionHistoryParamsSchema,
} from "./index.js"

describe("audit RPC contracts", () => {
  it("exposes skill inventory without a distribution RPC", () => {
    expect(rpcMethods["skill.inventory"].params.parse({})).toEqual({})
    expect(Object.keys(rpcMethods).filter((method) => (
      method.startsWith("skill.") && /install|copy|sync|distribut/i.test(method)
    ))).toEqual([])
  })

  it("requires exact reviewed skill content for enablement", () => {
    expect(rpcMethods["skill.setEnabled"].params.parse({
      id: "skill-111111111111",
      enabled: true,
      contentDigest: `sha256:${"a".repeat(64)}`,
      manifest: { version: 1, capabilities: ["filesystem.read"] },
    })).toEqual(expect.objectContaining({ enabled: true }))
  })
  const entry = {
    id: "audit-1",
    occurredAt: "2026-08-29T12:00:00.000Z",
    actor: { kind: "client", client: "desktop", clientId: "desktop-owner" },
    action: "terminal.input",
    outcome: "succeeded",
    sessionId: "session-1",
    projectId: "project-1",
    target: "terminal-1",
    detail: "command accepted",
  } as const

  it("bounds searchable audit filters and page cursors", () => {
    expect(auditQueryParamsSchema.parse({ query: "terminal", projectId: "project-1", limit: 25 })).toEqual({
      query: "terminal",
      projectId: "project-1",
      limit: 25,
    })
    expect(auditQueryParamsSchema.safeParse({ query: "x".repeat(513) }).success).toBe(false)
    expect(auditQueryParamsSchema.safeParse({ projectId: "x".repeat(513) }).success).toBe(false)
    expect(auditEntrySchema.parse(entry)).toEqual(entry)
    expect(auditEntrySchema.parse({
      ...entry,
      actor: { kind: "provider", provider: "codex", providerThreadId: "thread-1" },
      outcome: "started",
    }).actor.kind).toBe("provider")
    expect(auditEntrySchema.parse({
      ...entry,
      actor: { kind: "daemon", component: "shutdown" },
      outcome: "cancelled",
    }).actor.kind).toBe("daemon")
    expect(auditQueryPageSchema.parse({
      entries: [entry],
      hasMore: true,
      nextCursor: entry.id,
    }).nextCursor).toBe(entry.id)
    expect(auditQueryPageSchema.safeParse({
      entries: [entry],
      hasMore: true,
      nextCursor: "wrong",
    }).success).toBe(false)
    expect(auditQueryPageSchema.safeParse({
      entries: [],
      hasMore: true,
    }).success).toBe(false)
  })

  it("defines a bounded portable JSONL export", () => {
    const content = `${JSON.stringify(entry)}\n`
    expect(auditExportResultSchema.parse({
      format: "jsonl",
      exportedAt: "2026-08-29T12:01:00.000Z",
      entryCount: 1,
      content,
      hasMore: false,
    }).content).toBe(content)
    expect(auditExportResultSchema.safeParse({
      format: "jsonl",
      exportedAt: "2026-08-29T12:01:00.000Z",
      entryCount: 0,
      content: "x".repeat(2_000_001),
      hasMore: false,
    }).success).toBe(false)
    expect(auditExportResultSchema.safeParse({
      format: "jsonl",
      exportedAt: "2026-08-29T12:01:00.000Z",
      entryCount: 2,
      content,
      hasMore: false,
    }).success).toBe(false)
    expect(auditExportResultSchema.safeParse({
      format: "jsonl",
      exportedAt: "2026-08-29T12:01:00.000Z",
      entryCount: 1,
      content: "not-json\n",
      hasMore: false,
    }).success).toBe(false)
    expect(auditExportResultSchema.safeParse({
      format: "jsonl",
      exportedAt: "2026-08-29T12:01:00.000Z",
      entryCount: 1,
      content: `${JSON.stringify({ id: "not-an-audit-entry" })}\n`,
      hasMore: false,
    }).success).toBe(false)
  })
})

describe("provider secret RPC contracts", () => {
  it("does not expose secret mutation methods over RPC", () => {
    expect(Object.keys(rpcMethods)).not.toContain("provider.secret.set")
    expect(Object.keys(rpcMethods)).not.toContain("provider.secret.delete")
  })

  it("returns status-only keychain records", () => {
    expect(rpcMethods["provider.secret.list"].result.parse([
      { provider: "openai", state: "stored", source: "keychain" },
    ])).toEqual([
      { provider: "openai", state: "stored", source: "keychain" },
    ])
    expect(rpcMethods["provider.secret.list"].result.safeParse([
      { provider: "openai", state: "stored", source: "keychain", secret: "forbidden" },
    ]).success).toBe(false)
  })

})

describe("provider readiness refresh RPC contracts", () => {
  it("returns a daemon snapshot and accepts only an attributed client", () => {
    expect(rpcMethods["provider.refresh"].params.parse({ client: "desktop" })).toEqual({
      client: "desktop",
    })
    expect(rpcMethods["provider.refresh"].result.parse(demoWorkspace)).toEqual(demoWorkspace)
    expect(rpcMethods["provider.refresh"].params.safeParse({}).success).toBe(false)
    expect(rpcMethods["provider.refresh"].params.safeParse({
      client: "desktop",
      token: "forbidden",
    }).success).toBe(false)
  })
})

describe("session usage RPC contracts", () => {
  it("keeps token and reported-cost totals attributable to a runtime", () => {
    expect(rpcMethods["session.usage"].result.parse({
      sessionId: "session-1",
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      reasoningTokens: 1,
      totalTokens: 15,
      costMicros: 12_000,
      currency: "USD",
      reportedCostTurns: 1,
      unavailableCostTurns: 0,
      byRuntime: [{
        provider: "claude-code",
        model: "claude-opus",
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
        reasoningTokens: 1,
        totalTokens: 15,
        costMicros: 12_000,
        currency: "USD",
        turns: 1,
      }],
    }).byRuntime[0]).toMatchObject({ provider: "claude-code", model: "claude-opus" })
  })
})

describe("provider thread restart RPC contracts", () => {
  it("accepts only attributed strict restart requests", () => {
    expect(rpcMethods["session.restartProviderThread"].params.parse({
      sessionId: "session-1",
      client: "desktop",
    })).toEqual({ sessionId: "session-1", client: "desktop" })
    expect(rpcMethods["session.restartProviderThread"].params.safeParse({
      sessionId: "session-1",
      client: "desktop",
      secret: "forbidden",
    }).success).toBe(false)
    expect(rpcMethods["session.restartProviderThread"].params.safeParse({
      sessionId: "session-1",
    }).success).toBe(false)
    expect(rpcMethods["session.restartProviderThread"].result.parse(demoWorkspace)).toEqual(demoWorkspace)
  })
})

describe("authenticated client identity", () => {
  it("bounds optional hello client ids", () => {
    expect(helloParamsSchema.parse({
      client: "web",
      clientId: "browser-session-1",
      clientVersion: "1.0.0",
    })).toMatchObject({ client: "web", clientId: "browser-session-1" })
    expect(helloParamsSchema.safeParse({
      client: "web",
      clientId: "x".repeat(129),
      clientVersion: "1.0.0",
    }).success).toBe(false)
    expect(rpcMethods["system.hello"].result.parse({
      ...demoWorkspace,
      connectionId: "11111111-1111-4111-8111-111111111111",
    }).connectionId).toBe("11111111-1111-4111-8111-111111111111")
    expect(rpcMethods["system.hello"].result.parse(demoWorkspace).connectionId).toBeUndefined()
  })
})

describe("JSON-RPC envelopes", () => {
  it("registers a bounded emergency-stop contract distinct from pause-all", () => {
    expect(rpcMethods["system.emergencyStop"].params.parse({ client: "desktop" })).toEqual({
      client: "desktop",
    })
    expect(rpcMethods["system.emergencyStop"].params.safeParse({}).success).toBe(false)

    const result = {
      snapshot: demoWorkspace,
      stopId: "stop-2026-08-29",
      requestedAt: "2026-08-29T12:00:00.000Z",
      client: "desktop",
      outcomes: {
        turnsStopped: 2,
        terminalsClosed: 1,
        approvalsDenied: 3,
        mutationsCancelled: 4,
        providersReset: 2,
      },
      failures: [{
        target: "terminal",
        targetId: "terminal-2",
        message: "terminal had already exited",
      }],
    } as const

    expect(systemEmergencyStopResultSchema.parse(result)).toEqual(result)
    expect(rpcMethods["system.emergencyStop"].result.parse(result)).toEqual(result)
    expect(rpcMethods["system.emergencyStop"].result).not.toBe(
      rpcMethods["system.pauseAll"].result,
    )
    const notification = rpcNotificationSchema.parse({
      jsonrpc: "2.0",
      method: "system.emergencyStopped",
      params: result,
    })
    expect(systemEmergencyStoppedNotificationSchema.parse(notification.params)).toEqual(result)
  })

  it("bounds emergency-stop identifiers, counts, and failure detail", () => {
    const base = {
      snapshot: demoWorkspace,
      stopId: "stop-1",
      requestedAt: "2026-08-29T12:00:00.000Z",
      client: "web",
      outcomes: {
        turnsStopped: 0,
        terminalsClosed: 0,
        approvalsDenied: 0,
        mutationsCancelled: 0,
        providersReset: 0,
      },
      failures: [],
    }

    expect(systemEmergencyStopResultSchema.safeParse({
      ...base,
      stopId: "x".repeat(129),
    }).success).toBe(false)
    expect(systemEmergencyStopResultSchema.safeParse({
      ...base,
      outcomes: { ...base.outcomes, turnsStopped: Number.MAX_SAFE_INTEGER + 1 },
    }).success).toBe(false)
    expect(systemEmergencyStopResultSchema.safeParse({
      ...base,
      failures: Array.from({ length: 101 }, (_, index) => ({
        target: "turn",
        targetId: `turn-${index}`,
        message: "could not stop",
      })),
    }).success).toBe(false)
    expect(systemEmergencyStopResultSchema.safeParse({
      ...base,
      failures: [{ target: "approval", message: "x".repeat(513) }],
    }).success).toBe(false)
    expect(systemEmergencyStopResultSchema.parse({
      ...base,
      failures: [
        { target: "provider", targetId: "codex", message: "reset failed" },
        { target: "mutation", targetId: "mutation-1", message: "cancel failed" },
        { target: "persistence", message: "snapshot save failed" },
      ],
    }).failures).toHaveLength(3)
    expect(systemEmergencyStopResultSchema.safeParse({
      ...base,
      failures: [{ target: "queued-turn", message: "legacy target" }],
    }).success).toBe(false)
  })

  it("registers archive as a typed session mutation", () => {
    expect(rpcMethods["session.archive"].params.parse({
      sessionId: "session-billing",
      client: "desktop",
    })).toEqual({ sessionId: "session-billing", client: "desktop" })
    expect(rpcMethods["session.archive"].result.parse(demoWorkspace)).toEqual(demoWorkspace)
  })

  it("accepts valid requests, notifications, and exclusive responses", () => {
    expect(rpcRequestSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "workspace.get",
      params: {},
    }).id).toBe(1)
    expect(rpcRequestSchema.parse({
      jsonrpc: "2.0",
      id: "request-1",
      method: "future.method",
      params: [],
    }).method).toBe("future.method")
    expect(rpcNotificationSchema.parse({
      jsonrpc: "2.0",
      method: "workspace.changed",
      params: {},
    }).method).toBe("workspace.changed")
    expect(rpcResponseSchema.parse({ jsonrpc: "2.0", id: 1, result: null })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: null,
    })
    expect(rpcResponseSchema.parse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    }).id).toBeNull()
  })

  it.each([
    { jsonrpc: "2.0", id: "", method: "workspace.get", params: {} },
    { jsonrpc: "2.0", id: 1.5, method: "workspace.get", params: {} },
    { jsonrpc: "2.0", id: 1, method: "   ", params: {} },
    { jsonrpc: "2.0", id: 1, method: "workspace.get", params: "invalid" },
    { jsonrpc: "2.0", id: 1, method: "workspace.get", params: {}, result: {} },
  ])("rejects malformed request %#", (request) => {
    expect(rpcRequestSchema.safeParse(request).success).toBe(false)
  })

  it.each([
    { jsonrpc: "2.0", method: "   ", params: {} },
    { jsonrpc: "2.0", method: "workspace.changed", params: 1 },
    { jsonrpc: "2.0", id: 1, method: "workspace.changed", params: {} },
  ])("rejects malformed notification %#", (notification) => {
    expect(rpcNotificationSchema.safeParse(notification).success).toBe(false)
  })

  it.each([
    { jsonrpc: "2.0", id: 1 },
    {
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: -32603, message: "Internal error" },
    },
    { jsonrpc: "2.0", id: null, result: {} },
    { jsonrpc: "2.0", id: 1, error: { code: -32603.5, message: "Invalid code" } },
    { jsonrpc: "2.0", id: 1, result: {}, method: "workspace.get" },
  ])("rejects malformed response %#", (response) => {
    expect(rpcResponseSchema.safeParse(response).success).toBe(false)
  })
})

describe("RPC aggregate references", () => {
  const source = demoWorkspace.thread.find((item) => item.kind === "user")!
  const item = {
    id: `thread:${source.id}`,
    sourceId: source.id,
    sessionId: source.sessionId,
    category: "messages" as const,
    role: "user" as const,
    body: source.kind === "user" ? source.body : "",
    createdAt: source.createdAt,
  }

  it("accepts a history cursor that references the first returned item", () => {
    expect(sessionHistoryPageSchema.parse({
      sessionId: item.sessionId,
      items: [item],
      hasMore: true,
      nextCursor: item.id,
    }).nextCursor).toBe(item.id)
  })

  it.each([
    {
      sessionId: item.sessionId,
      items: [item],
      hasMore: true,
      nextCursor: "missing-item",
    },
    {
      sessionId: item.sessionId,
      items: [],
      hasMore: true,
      nextCursor: item.id,
    },
    {
      sessionId: item.sessionId,
      items: [item],
      hasMore: false,
      nextCursor: item.id,
    },
    {
      sessionId: item.sessionId,
      items: [item, item],
      hasMore: false,
    },
  ])("rejects malformed history aggregate %#", (page) => {
    expect(sessionHistoryPageSchema.safeParse(page).success).toBe(false)
  })

  it("reports one missing cursor issue without a redundant mismatch", () => {
    const result = sessionHistoryPageSchema.safeParse({
      sessionId: item.sessionId,
      items: [item],
      hasMore: true,
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.filter((issue) => issue.path[0] === "nextCursor")).toHaveLength(1)
    }
  })
})

describe("session history filters", () => {
  it("accepts bounded semantic categories and a normalized query", () => {
    expect(sessionHistoryParamsSchema.parse({
      sessionId: "session-billing",
      categories: ["messages", "tests"],
      query: "  vitest replay  ",
    })).toEqual({
      sessionId: "session-billing",
      categories: ["messages", "tests"],
      query: "vitest replay",
      limit: 50,
    })
    expect(sessionHistoryCategorySchema.options).toEqual([
      "messages",
      "tools",
      "approvals",
      "handoffs",
      "checkpoints",
      "annotations",
      "tests",
    ])
  })

  it.each([
    { categories: [] },
    { categories: ["messages", "messages"] },
    { categories: ["unknown"] },
    { query: "   " },
    { query: "x".repeat(257) },
  ])("rejects malformed history filters %#", (filters) => {
    expect(sessionHistoryParamsSchema.safeParse({
      sessionId: "session-billing",
      ...filters,
    }).success).toBe(false)
  })
})

describe("session fork RPC", () => {
  it("exposes an explicit fork-with-model contract", () => {
    expect(rpcMethods["session.fork"].params.parse({
      sessionId: "session-source",
      checkpointId: "checkpoint-source",
      requestId: "fork-request-1",
      runtime: demoWorkspace.sessions[0]!.runtime,
      client: "desktop",
    })).toMatchObject({ requestId: "fork-request-1" })
  })

  it.each(["", "x".repeat(129), "fork/request", " fork-request"])(
    "rejects malformed fork request ID %j",
    (requestId) => {
      expect(rpcMethods["session.fork"].params.safeParse({
        sessionId: "session-source",
        checkpointId: "checkpoint-source",
        requestId,
        runtime: demoWorkspace.sessions[0]!.runtime,
        client: "desktop",
      }).success).toBe(false)
    },
  )
})

describe("session evidence", () => {
  const evidence = {
    sessionId: "session-billing",
    refreshedAt: "2026-08-29T12:00:00.000Z",
    workspace: {
      baseCommit: "a".repeat(40),
      diff: "diff --git a/src/app.ts b/src/app.ts\n",
      diffTruncated: false,
      totalChangedFiles: 2,
      files: [
        {
          path: "src/app.ts",
          status: "modified" as const,
          staged: false,
          unstaged: true,
          additions: 3,
          deletions: 1,
          binary: false,
        },
        {
          path: "public/logo.png",
          status: "untracked" as const,
          staged: false,
          unstaged: true,
          additions: null,
          deletions: null,
          binary: true,
        },
      ],
      filesTruncated: false,
    },
    tests: {
      passed: 1,
      failed: 1,
      totalRuns: 2,
      runs: [
        {
          id: "tool-test",
          command: "pnpm test",
          commandTruncated: false,
          status: "passed" as const,
          output: "42 tests passed",
          outputTruncated: false,
          createdAt: "2026-08-29T11:59:00.000Z",
        },
      ],
      runsTruncated: true,
    },
  }

  it("accepts bounded Git and observed command-run evidence", () => {
    expect(sessionEvidenceSchema.parse(evidence)).toEqual(evidence)
  })

  it.each([
    { workspace: { ...evidence.workspace, totalChangedFiles: 1 } },
    { workspace: { ...evidence.workspace, files: [...evidence.workspace.files, evidence.workspace.files[0]] } },
    { tests: { ...evidence.tests, totalRuns: 0 } },
    { tests: { ...evidence.tests, passed: 2 } },
    { tests: { ...evidence.tests, failed: 2 } },
    {
      tests: {
        ...evidence.tests,
        passed: 0,
        failed: 2,
      },
    },
    {
      tests: {
        passed: 2,
        failed: 0,
        totalRuns: 2,
        runs: [evidence.tests.runs[0], evidence.tests.runs[0]],
        runsTruncated: false,
      },
    },
  ])("rejects inconsistent evidence aggregates %#", (override) => {
    expect(sessionEvidenceSchema.safeParse({ ...evidence, ...override }).success).toBe(false)
  })
})

describe("JSON value depth bounds", () => {
  const nest = (depth: number): unknown => {
    let value: unknown = 1
    for (let index = 0; index < depth; index += 1) value = [value]
    return value
  }

  it("rejects adversarially deep request params without throwing", () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: { payload: nest(100_000) },
    }
    let result: ReturnType<typeof rpcRequestSchema.safeParse> | undefined
    expect(() => {
      result = rpcRequestSchema.safeParse(request)
    }).not.toThrow()
    expect(result?.success).toBe(false)
  })

  it("rejects adversarially deep response results without throwing", () => {
    const response = { jsonrpc: "2.0", id: 1, result: nest(100_000) }
    let result: ReturnType<typeof rpcResponseSchema.safeParse> | undefined
    expect(() => {
      result = rpcResponseSchema.safeParse(response)
    }).not.toThrow()
    expect(result?.success).toBe(false)
  })

  it("accepts values exactly at the depth limit and rejects one level deeper", () => {
    const atLimit = { jsonrpc: "2.0", id: 1, result: nest(maximumJsonValueDepth) }
    const overLimit = { jsonrpc: "2.0", id: 1, result: nest(maximumJsonValueDepth + 1) }
    expect(rpcResponseSchema.safeParse(atLimit).success).toBe(true)
    expect(rpcResponseSchema.safeParse(overLimit).success).toBe(false)
  })

  it("accepts request params exactly at the depth limit and rejects one level deeper", () => {
    const atLimit = {
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: nest(maximumJsonValueDepth),
    }
    const overLimit = {
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: nest(maximumJsonValueDepth + 1),
    }
    expect(rpcRequestSchema.safeParse(atLimit).success).toBe(true)
    expect(rpcRequestSchema.safeParse(overLimit).success).toBe(false)
  })

  it("counts the params object itself as a nesting level", () => {
    const atLimit = {
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: { payload: nest(maximumJsonValueDepth - 1) },
    }
    const overLimit = {
      jsonrpc: "2.0",
      id: 1,
      method: "system.hello",
      params: { payload: nest(maximumJsonValueDepth) },
    }
    expect(rpcRequestSchema.safeParse(atLimit).success).toBe(true)
    expect(rpcRequestSchema.safeParse(overLimit).success).toBe(false)
  })

  it("accepts notification params exactly at the depth limit and rejects one level deeper", () => {
    const atLimit = {
      jsonrpc: "2.0",
      method: "system.hello",
      params: nest(maximumJsonValueDepth),
    }
    const overLimit = {
      jsonrpc: "2.0",
      method: "system.hello",
      params: nest(maximumJsonValueDepth + 1),
    }
    expect(rpcNotificationSchema.safeParse(atLimit).success).toBe(true)
    expect(rpcNotificationSchema.safeParse(overLimit).success).toBe(false)
  })

  it("counts the notification params object itself as a nesting level", () => {
    const atLimit = {
      jsonrpc: "2.0",
      method: "system.hello",
      params: { payload: nest(maximumJsonValueDepth - 1) },
    }
    const overLimit = {
      jsonrpc: "2.0",
      method: "system.hello",
      params: { payload: nest(maximumJsonValueDepth) },
    }
    expect(rpcNotificationSchema.safeParse(atLimit).success).toBe(true)
    expect(rpcNotificationSchema.safeParse(overLimit).success).toBe(false)
  })

  it("keeps rejecting responses that omit a result", () => {
    expect(rpcResponseSchema.safeParse({ jsonrpc: "2.0", id: 1 }).success).toBe(false)
  })

  it("still accepts ordinarily nested params and results", () => {
    const params = { payload: nest(16), note: { a: { b: ["c", { d: null }] } } }
    expect(rpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: "req-1",
      method: "system.hello",
      params,
    }).success).toBe(true)
    expect(rpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: "req-1",
      result: params,
    }).success).toBe(true)
  })
})
