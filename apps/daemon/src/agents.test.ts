import { describe, expect, it, vi } from "vitest"

import { AgentProviderUnavailableError, AgentRegistry, type AgentAdapter } from "./agents.js"

function adapter(): AgentAdapter {
  return {
    connect: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    startThread: vi.fn(async () => "thread"),
    resumeThread: vi.fn(async () => {}),
    stopThread: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    startTurn: vi.fn(async () => "turn"),
    steerTurn: vi.fn(async () => {}),
    resolveApproval: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
  }
}

describe("AgentRegistry", () => {
  it("routes registered provider ids to their adapters", () => {
    const codex = adapter()
    const claude = adapter()
    const registry = new AgentRegistry({ codex, "claude-code": claude })

    expect(registry.providers()).toEqual(["claude-code", "codex"])
    expect(registry.require("codex")).toBe(codex)
    expect(registry.require("claude-code")).toBe(claude)
  })

  it("rejects empty and unknown provider ids", () => {
    expect(() => new AgentRegistry({ "": adapter() })).toThrow("Provider id cannot be empty")

    const registry = new AgentRegistry({ codex: adapter() })
    expect(() => registry.require("opencode")).toThrow(AgentProviderUnavailableError)
    expect(() => registry.require("opencode")).toThrow("Agent provider opencode is unavailable")
  })
})
