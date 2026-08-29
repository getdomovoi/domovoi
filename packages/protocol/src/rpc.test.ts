import { describe, expect, it } from "vitest"

import {
  demoWorkspace,
  rpcNotificationSchema,
  rpcRequestSchema,
  rpcResponseSchema,
  sessionHistoryPageSchema,
} from "./index.js"

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
  const item = demoWorkspace.thread[0]!

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
