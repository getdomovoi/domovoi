import { describe, expect, it } from "vitest"

import { mapAcpSessionSetup, mapAcpUpdate } from "./acp-stdio.js"

describe("ACP stdio mapping", () => {
  it("maps advertised session modes and grouped config values", () => {
    expect(mapAcpSessionSetup({
      sessionId: "session-1",
      modes: {
        currentModeId: "ask",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "agent", name: "Agent" },
        ],
      },
      configOptions: [{
        type: "select",
        id: "model-id",
        name: "Model",
        category: "model",
        currentValue: "auto",
        options: [{
          group: "recommended",
          name: "Recommended",
          options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
        }],
      }],
    })).toEqual({
      sessionId: "session-1",
      modes: ["ask", "agent"],
      configOptions: [{
        id: "model-id",
        category: "model",
        currentValue: "auto",
        values: ["gpt-5.4"],
      }],
    })
  })

  it("maps text, plans, tools, diffs, and usage without exposing thought chunks", () => {
    expect(mapAcpUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    })).toEqual([{ type: "text", text: "hello" }])
    expect(mapAcpUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "private reasoning" },
    })).toEqual([])
    expect(mapAcpUpdate({
      sessionUpdate: "plan",
      entries: [{ content: "Test it", priority: "high", status: "in_progress" }],
    })).toEqual([{ type: "plan", text: "- [~] Test it" }])
    expect(mapAcpUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Patch file",
      status: "completed",
      content: [{ type: "diff", path: "src/a.ts", oldText: "a", newText: "b" }],
    })).toEqual([
      { type: "tool", toolCallId: "tool-1", phase: "completed", title: "Patch file" },
      { type: "diff", diff: "--- src/a.ts\n+++ src/a.ts\n-a\n+b" },
    ])
    expect(mapAcpUpdate({
      sessionUpdate: "usage_update",
      used: 120,
      size: 10_000,
      cost: { amount: 0.03, currency: "USD" },
    })).toEqual([{
      type: "usage",
      used: 120,
      size: 10_000,
      cost: { amount: 0.03, currency: "USD" },
    }])
  })
})
