import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, type WorkspaceDelta, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DomovoiClient, DomovoiRpcTimeoutError } from "./client"

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sent: string[] = []
  readyState = FakeWebSocket.CONNECTING

  constructor(readonly url: string) {
    super()
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event("close"))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }

  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }))
  }

  drop(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event("close"))
  }
}

describe("DomovoiClient", () => {
  const NativeWebSocket = globalThis.WebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = NativeWebSocket
    vi.useRealTimers()
  })

  it("reconnects after an unexpected close and publishes the recovered snapshot", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      reconnectDelayMs: 25,
    })
    const connected = vi.fn()
    const snapshots: WorkspaceSnapshot[] = []
    client.addEventListener("connected", connected)
    client.addEventListener("snapshot", (event) => {
      snapshots.push((event as CustomEvent<WorkspaceSnapshot>).detail)
    })

    const initial = client.connect()
    const first = FakeWebSocket.instances[0]!
    first.open()
    first.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await expect(initial).resolves.toEqual(demoWorkspace)

    first.drop()
    await vi.advanceTimersByTimeAsync(25)
    const second = FakeWebSocket.instances[1]!
    second.open()
    const recovered = structuredClone(demoWorkspace)
    recovered.activeSessionId = "session-audit"
    second.receive({ jsonrpc: "2.0", id: 2, result: recovered })
    await vi.runAllTimersAsync()

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(connected).toHaveBeenCalledTimes(2)
    expect(snapshots.at(-1)?.activeSessionId).toBe("session-audit")
    client.disconnect()
  })

  it("authenticates the initial daemon handshake", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      authToken: "secret-token",
    })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      method: "system.hello",
      params: { client: "web", authToken: "secret-token" },
    })
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    client.disconnect()
  })

  it("publishes validated workspace deltas", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web")
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const received: WorkspaceDelta[] = []
    client.addEventListener("workspace-delta", (event) => {
      received.push((event as CustomEvent<WorkspaceDelta>).detail)
    })
    const session = demoWorkspace.sessions[0]!
    socket.receive({
      jsonrpc: "2.0",
      method: "workspace.delta",
      params: {
        sessionId: session.id,
        updatedAt: session.updatedAt,
        operations: [{
          kind: "assistant.append",
          id: "assistant-turn-1",
          delta: "Streamed",
          createdAt: session.updatedAt,
        }],
      },
    })
    socket.receive({
      jsonrpc: "2.0",
      method: "workspace.delta",
      params: { sessionId: session.id, updatedAt: session.updatedAt, operations: "invalid" },
    })

    expect(received).toHaveLength(1)
    expect(received[0]?.operations[0]).toMatchObject({ delta: "Streamed" })
    client.disconnect()
  })

  it("requests preview access scoped to the bridge channel", async () => {
    const client = new DomovoiClient("wss://machine.example/rpc", "tablet")
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting

    const authorizing = client.authorizeArtifact("artifact-preview", "preview_channel_123456")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "artifact.authorize",
      params: {
        artifactId: "artifact-preview",
        bridgeChannel: "preview_channel_123456",
        client: "tablet",
      },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: {
        artifactId: "artifact-preview",
        bridgeChannel: "preview_channel_123456",
        expiresAt: 1_800_000_000,
        signature: "a".repeat(43),
      },
    })

    await expect(authorizing).resolves.toMatchObject({ artifactId: "artifact-preview" })
    client.disconnect()
  })

  it("requests older session history by cursor", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop")
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const session = demoWorkspace.sessions[0]!
    const item = demoWorkspace.thread.find((candidate) => candidate.sessionId === session.id)!

    const loading = client.loadSessionHistory(session.id, {
      before: `thread:${item.id}`,
      limit: 25,
      categories: ["messages", "tests"],
      query: "replay",
    })
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "session.history",
      params: {
        sessionId: session.id,
        before: `thread:${item.id}`,
        limit: 25,
        categories: ["messages", "tests"],
        query: "replay",
      },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessionId: session.id,
        items: [{
          id: `thread:${item.id}`,
          sourceId: item.id,
          sessionId: item.sessionId,
          category: "messages",
          role: "user",
          body: item.kind === "user" ? item.body : "",
          createdAt: item.createdAt,
        }],
        hasMore: false,
      },
    })

    await expect(loading).resolves.toMatchObject({ hasMore: false })
    client.disconnect()
  })

  it("requests and validates refreshed session evidence", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop")
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const session = demoWorkspace.sessions[0]!

    const loading = client.loadSessionEvidence(session.id)
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "session.evidence",
      params: { sessionId: session.id },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessionId: session.id,
        refreshedAt: "2026-08-29T12:00:00.000Z",
        workspace: {
          baseCommit: "a".repeat(40),
          diff: "",
          diffTruncated: false,
          totalChangedFiles: 0,
          files: [],
          filesTruncated: false,
        },
        tests: {
          passed: 0,
          failed: 0,
          totalRuns: 0,
          runs: [],
          runsTruncated: false,
        },
      },
    })

    await expect(loading).resolves.toMatchObject({ sessionId: session.id })
    client.disconnect()
  })

  it("streams interactive terminal events and input", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", {
      clientId: "desktop-client-1",
    })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const output = vi.fn()
    const ownership = vi.fn()
    client.addEventListener("terminal-output", output)
    client.addEventListener("terminal-ownership", ownership)

    const creating = client.createTerminal(
      "session-billing",
      { cols: 120, rows: 32 },
      "terminal-1",
    )
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "terminal.create",
      params: {
        terminalId: "terminal-1",
        sessionId: "session-billing",
        cols: 120,
        rows: 32,
        clientId: "desktop-client-1",
      },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: {
        terminalId: "terminal-1",
        sessionId: "session-billing",
        cols: 120,
        rows: 32,
        shell: "bash",
        cwd: "/worktrees/billing",
        buffer: "",
        owner: { client: "desktop", clientId: "desktop-client-1" },
      },
    })
    await expect(creating).resolves.toMatchObject({ terminalId: "terminal-1" })
    socket.receive({
      jsonrpc: "2.0",
      method: "terminal.output",
      params: { terminalId: "terminal-1", data: "ready\r\n" },
    })
    expect((output.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      terminalId: "terminal-1",
      data: "ready\r\n",
    })

    const writing = client.writeTerminal("terminal-1", "pnpm test\r")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "terminal.input",
      params: {
        terminalId: "terminal-1",
        data: "pnpm test\r",
        clientId: "desktop-client-1",
      },
    })
    socket.receive({ jsonrpc: "2.0", id: 3, result: { accepted: true } })
    await expect(writing).resolves.toBeUndefined()

    socket.receive({
      jsonrpc: "2.0",
      method: "terminal.ownership",
      params: {
        terminalId: "terminal-1",
        owner: { client: "tablet", clientId: "tablet-client-1" },
      },
    })
    expect((ownership.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({
      terminalId: "terminal-1",
      owner: { client: "tablet", clientId: "tablet-client-1" },
    })

    const claiming = client.claimTerminal("terminal-1")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "terminal.claim",
      params: { terminalId: "terminal-1", clientId: "desktop-client-1" },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 4,
      result: {
        terminalId: "terminal-1",
        owner: { client: "desktop", clientId: "desktop-client-1" },
      },
    })
    await expect(claiming).resolves.toMatchObject({
      owner: { clientId: "desktop-client-1" },
    })
    client.disconnect()
  })

  it("does not retry a rejected daemon credential", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      authToken: "wrong-token",
      reconnectDelayMs: 25,
    })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "Daemon authentication failed" },
    })

    await expect(connecting).rejects.toThrow("Daemon authentication failed")
    await vi.advanceTimersByTimeAsync(25)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it("rejects an in-flight request when the connection closes", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", {
      reconnectDelayMs: 25,
    })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const request = client.activateSession("session-audit")
    socket.drop()

    await expect(request).rejects.toThrow("Daemon connection closed")
    client.disconnect()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds web RPC requests with a stable timeout error", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      requestTimeoutMs: 50,
    })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const request = client.activateSession("session-audit")
    const error = request.catch((cause: unknown) => cause)
    await vi.advanceTimersByTimeAsync(50)

    await expect(error).resolves.toMatchObject({
      name: "DomovoiRpcTimeoutError",
      method: "session.activate",
      timeoutMs: 50,
    })
    await expect(error).resolves.toBeInstanceOf(DomovoiRpcTimeoutError)
    client.disconnect()
  })

  it("rejects deadlines above the browser timer maximum", async () => {
    const oversizedTimeoutMs = 2_147_483_648

    expect(() => new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      requestTimeoutMs: oversizedTimeoutMs,
    })).toThrow(RangeError)

    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    expect(() => client.request(
      "session.activate",
      { sessionId: "session-audit", client: "web" },
      { timeoutMs: oversizedTimeoutMs },
    )).toThrow(RangeError)
    client.disconnect()
  })

  it("allows multi-step RPC work until the 120-second default deadline", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const request = client.sendMessage("session-billing", "Run the full verification.")
    const result = request.catch((cause: unknown) => cause)
    let settled = false
    void result.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(90_000)

    await expect(result).resolves.toMatchObject({
      name: "DomovoiRpcTimeoutError",
      method: "session.send",
      timeoutMs: 120_000,
    })
    client.disconnect()
  })

  it("ignores a late response without affecting a newer desktop request", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", {
      requestTimeoutMs: 100,
    })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const expired = client.activateSession("session-audit")
    const expiration = expired.catch((cause: unknown) => cause)
    await vi.advanceTimersByTimeAsync(100)
    await expect(expiration).resolves.toBeInstanceOf(DomovoiRpcTimeoutError)

    const current = client.activateSession("session-billing")
    let currentSettled = false
    void current.then(() => {
      currentSettled = true
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await Promise.resolve()
    expect(currentSettled).toBe(false)

    const currentWorkspace = structuredClone(demoWorkspace)
    currentWorkspace.activeSessionId = "session-billing"
    socket.receive({ jsonrpc: "2.0", id: 3, result: currentWorkspace })

    await expect(current).resolves.toEqual(currentWorkspace)
    client.disconnect()
  })

  it("cancels a request through AbortSignal and clears its deadline", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", {
      requestTimeoutMs: 5_000,
    })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial
    const controller = new AbortController()

    const request = client.request(
      "session.activate",
      { sessionId: "session-audit", client: "desktop" },
      { signal: controller.signal },
    )
    const cancellation = request.catch((cause: unknown) => cause)
    controller.abort()

    await expect(cancellation).resolves.toMatchObject({ name: "AbortError" })
    expect(vi.getTimerCount()).toBe(0)

    const current = client.activateSession("session-billing")
    let currentSettled = false
    void current.then(() => {
      currentSettled = true
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await Promise.resolve()
    expect(currentSettled).toBe(false)
    socket.receive({ jsonrpc: "2.0", id: 3, result: demoWorkspace })
    await expect(current).resolves.toEqual(demoWorkspace)
    client.disconnect()
  })

  it("clears a request deadline after a successful response", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      requestTimeoutMs: 5_000,
    })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const request = client.activateSession("session-audit")
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })

    await expect(request).resolves.toEqual(demoWorkspace)
    expect(vi.getTimerCount()).toBe(0)
    client.disconnect()
  })

  it("clears a request deadline after a daemon rejection", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      requestTimeoutMs: 5_000,
    })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const request = client.activateSession("missing-session")
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602, message: "Unknown session" },
    })

    await expect(request).rejects.toThrow("Unknown session")
    expect(vi.getTimerCount()).toBe(0)
    client.disconnect()
  })

  it("rejects connect when disconnected before the socket opens", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web")

    const connecting = client.connect()
    client.disconnect()

    await expect(connecting).rejects.toThrow("Daemon connection closed")
  })

  it("reuses an in-progress connection attempt", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web")

    const first = client.connect()
    const second = client.connect()

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(second).toBe(first)
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await expect(Promise.all([first, second])).resolves.toEqual([demoWorkspace, demoWorkspace])
    client.disconnect()
  })

  it("retries immediately without leaving the scheduled retry active", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      reconnectDelayMs: 25,
    })
    const initial = client.connect()
    const first = FakeWebSocket.instances[0]!
    first.open()
    first.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial
    first.drop()

    const retry = client.connect()
    expect(FakeWebSocket.instances).toHaveLength(2)
    const second = FakeWebSocket.instances[1]!
    second.open()
    second.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await retry
    await vi.advanceTimersByTimeAsync(25)

    expect(FakeWebSocket.instances).toHaveLength(2)
    client.disconnect()
  })

  it("attributes annotation mutations to the current client", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "tablet")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const creating = client.createAnnotation({
      sessionId: "session-billing",
      artifactId: "artifact-preview",
      anchor: { textQuote: "Replay operations" },
      body: "Keep the progress visible.",
    })
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "annotation.create",
      params: { client: "tablet", artifactId: "artifact-preview" },
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await creating

    const replying = client.replyToAnnotation("annotation-replay-copy", "Agreed.")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "annotation.reply",
      params: { client: "tablet", body: "Agreed." },
    })
    socket.receive({ jsonrpc: "2.0", id: 3, result: demoWorkspace })
    await replying

    const resolving = client.setAnnotationStatus("annotation-replay-copy", "resolved")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "annotation.setStatus",
      params: { client: "tablet", status: "resolved" },
    })
    socket.receive({ jsonrpc: "2.0", id: 4, result: demoWorkspace })
    await resolving
    client.disconnect()
  })

  it("attributes checkpoint restores to the current client", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "tablet")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const restoring = client.restoreCheckpoint("session-billing", "checkpoint-1")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "checkpoint.restore",
      params: {
        sessionId: "session-billing",
        checkpointId: "checkpoint-1",
        client: "tablet",
      },
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await expect(restoring).resolves.toEqual(demoWorkspace)
    client.disconnect()
  })

  it("sends explicit checkpoint fork intent with a stable request ID", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "tablet")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const forking = client.forkSession({
      sessionId: "session-billing",
      checkpointId: "thread-checkpoint",
      runtime: demoWorkspace.sessions[0]!.runtime,
      requestId: "fork-request-tablet",
    })
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "session.fork",
      params: {
        sessionId: "session-billing",
        checkpointId: "thread-checkpoint",
        requestId: "fork-request-tablet",
        runtime: demoWorkspace.sessions[0]!.runtime,
        client: "tablet",
      },
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await expect(forking).resolves.toEqual(demoWorkspace)
    client.disconnect()
  })

  it("lists provider models without parsing them as workspace state", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const listing = client.listModels("codex")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "runtime.models",
      params: { provider: "codex", client: "desktop" },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: [{
        provider: "codex",
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Coding model",
        supportedReasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      }],
    })

    await expect(listing).resolves.toEqual([
      expect.objectContaining({ id: "gpt-5.6-sol", provider: "codex" }),
    ])
    client.disconnect()
  })

  it("lists daemon skills without parsing them as workspace state", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const listing = client.listSkills()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "skill.list",
      params: {},
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: [{
        id: "skill-4d6f4d6f4d6f",
        name: "repo-audit",
        description: "Audit a repository and render a ranked report.",
        path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
        scope: "user",
        source: "agents",
      }],
    })

    await expect(listing).resolves.toEqual([
      expect.objectContaining({ name: "repo-audit", source: "agents" }),
    ])
    client.disconnect()
  })

  it("reads skill source by discovered ID", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const document = client.readSkill("skill-4d6f4d6f4d6f")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "skill.read",
      params: { id: "skill-4d6f4d6f4d6f" },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: {
        skill: {
          id: "skill-4d6f4d6f4d6f",
          name: "repo-audit",
          description: "Audit a repository and render a ranked report.",
          path: "/home/dev/.agents/skills/repo-audit/SKILL.md",
          scope: "user",
          source: "agents",
        },
        content: "---\nname: repo-audit\n---\n",
      },
    })

    await expect(document).resolves.toMatchObject({
      skill: { name: "repo-audit" },
      content: expect.stringContaining("name: repo-audit"),
    })
    client.disconnect()
  })

  it("queries and exports typed audit records with bounded request controls", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const query = client.queryAudit({ query: "session", limit: 25 })
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "audit.query",
      params: { query: "session", limit: 25 },
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: { entries: [], hasMore: false } })
    await expect(query).resolves.toEqual({ entries: [], hasMore: false })

    const exported = client.exportAudit({ format: "jsonl", limit: 100 })
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "audit.export",
      params: { format: "jsonl", limit: 100 },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 3,
      result: {
        format: "jsonl",
        exportedAt: "2026-08-29T18:30:00.000Z",
        entryCount: 0,
        content: "",
        hasMore: false,
      },
    })
    await expect(exported).resolves.toMatchObject({ format: "jsonl", entryCount: 0 })
    client.disconnect()
  })

  it("preserves the parser failure for an invalid RPC result", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const listing = client.listModels("codex")
    socket.receive({ jsonrpc: "2.0", id: 2, result: [{}] })
    const error = await listing.catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Daemon returned an invalid RPC result")
    expect((error as Error).cause).toBeInstanceOf(Error)
    client.disconnect()
  })

  it("uses the registered result parser when none is supplied", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const listing = client.request("runtime.models", {
      provider: "codex",
      client: "desktop",
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: [] })

    await expect(listing).resolves.toEqual([])
    client.disconnect()
  })

  it("attributes the global pause to the current client", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "phone")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const pausing = client.pauseAll()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "system.pauseAll",
      params: { client: "phone" },
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await expect(pausing).resolves.toEqual(demoWorkspace)

    const stopping = client.pauseSession("session-billing")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "session.pause",
      params: { sessionId: "session-billing", client: "phone" },
    })
    socket.receive({ jsonrpc: "2.0", id: 3, result: demoWorkspace })
    await expect(stopping).resolves.toEqual(demoWorkspace)
    client.disconnect()
  })

  it("attributes session archive to the shared client kind", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web")
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const archiving = client.archiveSession("session-billing")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "session.archive",
      params: { sessionId: "session-billing", client: "web" },
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await expect(archiving).resolves.toEqual(demoWorkspace)
    client.disconnect()
  })
})
