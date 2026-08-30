import { describe, expect, it } from "vitest"

import { CURSOR_ACP_PROVIDER, GROK_ACP_PROVIDER, parseAcpModelCatalog } from "./acp-providers.js"

describe("ACP provider definitions", () => {
  it("launches Cursor and Grok without bypass flags", () => {
    expect(CURSOR_ACP_PROVIDER).toMatchObject({
      id: "cursor-agent",
      commands: ["agent", "cursor-agent"],
      launchArgs: ["acp"],
      modelArgs: ["models"],
      modes: { ask: "ask", plan: "plan", build: "agent" },
    })
    expect(GROK_ACP_PROVIDER).toMatchObject({
      id: "grok",
      commands: ["grok"],
      launchArgs: ["agent", "stdio"],
      modelArgs: ["models"],
      modes: { ask: "default", plan: "plan", build: "acceptEdits" },
    })
    expect(JSON.stringify([CURSOR_ACP_PROVIDER, GROK_ACP_PROVIDER])).not.toMatch(
      /always-approve|yolo|autoMode/i,
    )
  })

  it("normalizes plain-text and JSON model catalogs without inventing reasoning levels", () => {
    expect(parseAcpModelCatalog("cursor-agent", "gpt-5.4\nclaude-4.6-sonnet (default)\n")).toEqual([
      {
        provider: "cursor-agent",
        id: "gpt-5.4",
        displayName: "gpt-5.4",
        description: "",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "none",
        isDefault: false,
      },
      expect.objectContaining({
        id: "claude-4.6-sonnet",
        displayName: "claude-4.6-sonnet",
        isDefault: true,
      }),
    ])
    expect(parseAcpModelCatalog("grok", JSON.stringify([
      { id: "grok-code-fast-1", name: "Grok Code Fast", default: true },
    ]))).toEqual([
      expect.objectContaining({
        provider: "grok",
        id: "grok-code-fast-1",
        displayName: "Grok Code Fast",
        isDefault: true,
      }),
    ])
  })

  it("drops banners and malformed catalog entries", () => {
    expect(parseAcpModelCatalog("grok", "Available models:\n\n- grok-code-fast-1\nlogin required\n")).toEqual([
      expect.objectContaining({ id: "grok-code-fast-1" }),
    ])
  })
})
