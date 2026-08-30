import type { Runtime } from "@getdomovoi/protocol"
import { describe, expect, it, vi } from "vitest"

import type { AcpPeer, AcpPeerHandlers, AcpSessionSetup, AcpUpdate } from "./acp.js"
import { AcpAgentAdapter } from "./acp.js"
import { CURSOR_ACP_PROVIDER } from "./acp-providers.js"

const runtime: Runtime = {
  provider: "cursor-agent",
  model: "gpt-5.4",
  reasoning: "high",
  permissionMode: "plan",
  auto: false,
}

class FakePeer implements AcpPeer {
  handlers?: AcpPeerHandlers
  setup: AcpSessionSetup = {
    sessionId: "acp-session",
    modes: ["ask", "plan", "agent"],
    configOptions: [
      { id: "model", category: "model", values: ["gpt-5.4"], currentValue: "auto" },
      { id: "thinking", category: "thought_level", values: ["low", "high"], currentValue: "low" },
    ],
  }
  initialize = vi.fn(async () => undefined)
  startSession = vi.fn(async () => this.setup)
  resumeSession = vi.fn(async () => this.setup)
  closeSession = vi.fn(async () => undefined)
  setMode = vi.fn(async () => undefined)
  setConfig = vi.fn(async () => undefined)
  prompt = vi.fn(async () => ({ stopReason: "end_turn" }))
  cancel = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
}

function createHarness() {
  const peer = new FakePeer()
  const adapter = new AcpAgentAdapter({
    definition: CURSOR_ACP_PROVIDER,
    createPeer: (handlers) => {
      peer.handlers = handlers
      return peer
    },
    listModels: async () => [{
      provider: "cursor-agent",
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      description: "",
      supportedReasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
      isDefault: true,
    }],
    createId: vi.fn()
      .mockReturnValueOnce("local-turn")
      .mockReturnValueOnce("approval-1"),
  })
  return { adapter, peer }
}

describe("AcpAgentAdapter", () => {
  it("negotiates model, reasoning, and the provider's safe mode", async () => {
    const { adapter, peer } = createHarness()
    await adapter.connect()

    expect(await adapter.startThread({ cwd: "/repo", runtime })).toBe("acp-session")
    expect(peer.initialize).toHaveBeenCalledOnce()
    expect(peer.startSession).toHaveBeenCalledWith("/repo")
    expect(peer.setConfig).toHaveBeenNthCalledWith(1, "acp-session", "model", "gpt-5.4")
    expect(peer.setConfig).toHaveBeenNthCalledWith(2, "acp-session", "thinking", "high")
    expect(peer.setMode).toHaveBeenCalledWith("acp-session", "plan")
  })

  it("rejects unadvertised modes instead of silently widening permissions", async () => {
    const { adapter, peer } = createHarness()
    peer.setup.modes = ["agent"]
    await adapter.connect()

    await expect(adapter.startThread({ cwd: "/repo", runtime })).rejects.toThrow(
      "does not advertise mode plan",
    )
  })

  it("streams updates and completes an asynchronous prompt with a local turn id", async () => {
    const { adapter, peer } = createHarness()
    const events: unknown[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    await adapter.startThread({ cwd: "/repo", runtime })
    peer.prompt.mockImplementation(async () => {
      peer.handlers?.onUpdate("acp-session", {
        type: "text",
        text: "Working",
      })
      peer.handlers?.onUpdate("acp-session", {
        type: "tool",
        toolCallId: "tool-1",
        phase: "started",
        title: "Run tests",
      })
      return { stopReason: "end_turn" }
    })

    expect(await adapter.startTurn({ threadId: "acp-session", cwd: "/repo", prompt: "Ship it", runtime }))
      .toBe("local-turn")
    await vi.waitFor(() => expect(events).toContainEqual({
      type: "turn-completed",
      params: { threadId: "acp-session", turnId: "local-turn", status: "completed" },
    }))
    expect(events).toContainEqual({
      type: "text-delta",
      threadId: "acp-session",
      turnId: "local-turn",
      delta: "Working",
    })
    expect(events).toContainEqual(expect.objectContaining({ type: "item", phase: "started" }))
  })

  it("maps project grants to allow-once and cancellation drains pending permissions", async () => {
    const { adapter, peer } = createHarness()
    const events: unknown[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    await adapter.startThread({ cwd: "/repo", runtime })

    const permission = peer.handlers!.onPermission({
      sessionId: "acp-session",
      toolCallId: "tool-1",
      title: "Write file",
      options: [
        { id: "once", kind: "allow_once" },
        { id: "always", kind: "allow_always" },
        { id: "reject", kind: "reject_once" },
      ],
    })
    const approval = events.find((event): event is { requestId: number } => (
      typeof event === "object" && event !== null && "requestId" in event
    ))
    adapter.resolveApproval(approval!.requestId, "always-project")
    await expect(permission).resolves.toEqual({ optionId: "once" })

    const cancelled = peer.handlers!.onPermission({
      sessionId: "acp-session",
      toolCallId: "tool-2",
      title: "Run command",
      options: [{ id: "once", kind: "allow_once" }],
    })
    await adapter.interruptTurn("acp-session", "local-turn")
    await expect(cancelled).resolves.toEqual({ cancelled: true })
    expect(peer.cancel).toHaveBeenCalledWith("acp-session")
  })

  it("cancels an active turn before closing a session", async () => {
    const { adapter, peer } = createHarness()
    peer.prompt.mockImplementation(() => new Promise(() => {}))
    await adapter.connect()
    await adapter.startThread({ cwd: "/repo", runtime })
    await adapter.startTurn({ threadId: "acp-session", cwd: "/repo", prompt: "Ship it", runtime })

    await adapter.stopThread("acp-session")

    expect(peer.cancel).toHaveBeenCalledWith("acp-session")
    expect(peer.closeSession).toHaveBeenCalledWith("acp-session")
    expect(peer.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      peer.closeSession.mock.invocationCallOrder[0]!,
    )
  })

  it("declares build-auto and mid-turn steering unsupported", async () => {
    const { adapter } = createHarness()
    expect(adapter.permissionCapabilities).toEqual({ buildAuto: "unsupported" })
    await expect(adapter.steerTurn("thread", "turn", "change course")).rejects.toThrow(
      "does not support mid-turn steering",
    )
  })

  it("reports provider disconnects once with a bounded reason", async () => {
    const { adapter, peer } = createHarness()
    const events: unknown[] = []
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    peer.handlers?.onDisconnect("token=super-secret\nprocess exited")
    peer.handlers?.onDisconnect("again")

    expect(events).toEqual([{
      type: "provider-disconnected",
      reason: "Provider process exited unexpectedly",
    }])
  })

  it("tolerates usage updates until normalized telemetry owns them", async () => {
    const { adapter, peer } = createHarness()
    await adapter.connect()
    await adapter.startThread({ cwd: "/repo", runtime })
    expect(() => peer.handlers?.onUpdate("acp-session", {
      type: "usage",
      used: 100,
      size: 10_000,
      cost: { amount: 0.01, currency: "USD" },
    } satisfies AcpUpdate)).not.toThrow()
  })
})
