import type { Runtime } from "@getdomovoi/protocol"
import { describe, expect, it, vi } from "vitest"

import type { AcpPeer, AcpPeerHandlers, AcpSessionSetup, AcpUpdate } from "./acp.js"
import { AcpAgentAdapter } from "./acp.js"
import { CURSOR_ACP_PROVIDER } from "./acp-providers.js"
import type { AgentEvent } from "./agents.js"

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
  it("closes a failed peer and creates a fresh peer on retry", async () => {
    const failedPeer = new FakePeer()
    failedPeer.initialize.mockRejectedValueOnce(new Error("initialize failed"))
    const retryPeer = new FakePeer()
    const createPeer = vi.fn()
      .mockReturnValueOnce(failedPeer)
      .mockReturnValueOnce(retryPeer)
    const adapter = new AcpAgentAdapter({
      definition: CURSOR_ACP_PROVIDER,
      createPeer,
      listModels: async () => [],
    })

    await expect(adapter.connect()).rejects.toThrow("initialize failed")
    expect(failedPeer.close).toHaveBeenCalledOnce()
    await expect(adapter.connect()).resolves.toBeUndefined()
    expect(retryPeer.initialize).toHaveBeenCalledOnce()
    expect(createPeer).toHaveBeenCalledTimes(2)
  })

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

  it("omits an unavailable reasoning config when runtime reasoning is none", async () => {
    const { adapter, peer } = createHarness()
    await adapter.connect()

    await expect(adapter.startThread({
      cwd: "/repo",
      runtime: { ...runtime, reasoning: "none" },
    })).resolves.toBe("acp-session")
    expect(peer.setConfig).toHaveBeenCalledOnce()
    expect(peer.setConfig).toHaveBeenCalledWith("acp-session", "model", "gpt-5.4")
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

  it("recovers from disconnect without letting a stale peer clear its replacement", async () => {
    const firstPeer = new FakePeer()
    firstPeer.prompt.mockImplementation(() => new Promise(() => {}))
    const replacementPeer = new FakePeer()
    replacementPeer.prompt.mockImplementation(() => new Promise(() => {}))
    const peers = [firstPeer, replacementPeer]
    const createPeer = vi.fn((handlers: AcpPeerHandlers) => {
      const peer = peers.shift()!
      peer.handlers = handlers
      return peer
    })
    const adapter = new AcpAgentAdapter({
      definition: CURSOR_ACP_PROVIDER,
      createPeer,
      listModels: async () => [],
      createId: vi.fn()
        .mockReturnValueOnce("first-turn")
        .mockReturnValueOnce("replacement-turn"),
    })
    const events: AgentEvent[] = []
    adapter.onEvent((event) => events.push(event))

    await adapter.connect()
    await adapter.startTurn({ threadId: "acp-session", cwd: "/repo", prompt: "first", runtime })
    firstPeer.handlers!.onDisconnect()
    await adapter.connect()
    await expect(adapter.startTurn({
      threadId: "acp-session",
      cwd: "/repo",
      prompt: "replacement",
      runtime,
    })).resolves.toBe("replacement-turn")

    firstPeer.handlers!.onUpdate("acp-session", { type: "text", text: "stale update" })
    const stalePermission = firstPeer.handlers!.onPermission({
      sessionId: "acp-session",
      toolCallId: "stale-tool",
      title: "Stale permission",
      options: [{ id: "once", kind: "allow_once" }],
    })
    replacementPeer.handlers!.onUpdate("acp-session", { type: "text", text: "current update" })

    await expect(stalePermission).resolves.toEqual({ cancelled: true })
    expect(events).not.toContainEqual(expect.objectContaining({ delta: "stale update" }))
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "approval-requested",
      itemId: "stale-tool",
    }))
    expect(events).toContainEqual(expect.objectContaining({ delta: "current update" }))

    firstPeer.handlers!.onDisconnect()
    await expect(adapter.startThread({ cwd: "/repo", runtime })).resolves.toBe("acp-session")
    expect(replacementPeer.initialize).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === "provider-disconnected")).toHaveLength(1)
  })

  it("emits ACP aggregate usage without inventing a token breakdown", async () => {
    const { adapter, peer } = createHarness()
    const events: AgentEvent[] = []
    peer.prompt.mockImplementation(() => new Promise(() => {}))
    adapter.onEvent((event) => events.push(event))
    await adapter.connect()
    await adapter.startThread({ cwd: "/repo", runtime })
    await adapter.startTurn({ threadId: "acp-session", cwd: "/repo", prompt: "Ship it", runtime })
    peer.handlers?.onUpdate("acp-session", {
      type: "usage",
      used: 100,
      size: 10_000,
      cost: { amount: 0.01, currency: "USD" },
    } satisfies AcpUpdate)

    expect(events).toContainEqual({
      type: "usage",
      threadId: "acp-session",
      turnId: "local-turn",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 100,
        costMicros: 10_000,
        currency: "USD",
        costSource: "provider-reported",
      },
    })
  })
})
