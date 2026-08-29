import { describe, expect, it } from "vitest"

import {
  auditEntrySchema,
  auditExportResultSchema,
  auditQueryPageSchema,
  auditQueryParamsSchema,
  demoWorkspace,
  rpcNotificationSchema,
  rpcRequestSchema,
  rpcResponseSchema,
  sessionHistoryCategorySchema,
  sessionHistoryPageSchema,
  sessionHistoryParamsSchema,
} from "./index.js"

describe("audit RPC contracts", () => {
  const entry = {
    id: "audit-1",
    occurredAt: "2026-08-29T12:00:00.000Z",
    actor: { kind: "client", client: "desktop", clientId: "desktop-owner" },
    action: "terminal.input",
    outcome: "succeeded",
    sessionId: "session-1",
    target: "terminal-1",
    detail: "command accepted",
  } as const

  it("bounds searchable audit filters and page cursors", () => {
    expect(auditQueryParamsSchema.parse({ query: "terminal", limit: 25 })).toEqual({
      query: "terminal",
      limit: 25,
    })
    expect(auditQueryParamsSchema.safeParse({ query: "x".repeat(513) }).success).toBe(false)
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

describe("JSON-RPC envelopes", () => {
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
