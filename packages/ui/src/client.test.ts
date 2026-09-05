import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, fleetSnapshotOverflowErrorCode, maximumFleetEntries, protocolVersion, type SystemEmergencyStoppedNotification, type WorkspaceDelta, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DaemonRpcError, DomovoiClient, DomovoiConnectTimeoutError, DomovoiRpcTimeoutError, ProjectSwitchConfirmationError } from "./client"
import { Deadline } from "./deadline"

const skillSecurityMetadata = {
  manifest: { version: 1 as const, capabilities: [] },
  contentDigest: `sha256:${"a".repeat(64)}`,
  signature: { state: "unsigned" as const },
  trust: { state: "untrusted" as const, reason: "unsigned" as const },
}

const budgets = { connectMs: 10_000, requestMs: 120_000 }

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

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchClose(code, reason)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }

  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }))
  }

  drop(code = 1006, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchClose(code, reason)
  }

  private dispatchClose(code: number, reason: string): void {
    const event = new Event("close")
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    })
    this.dispatchEvent(event)
  }
}

class ManualScheduler {
  readonly delays: number[] = []
  readonly callbacks = new Map<number, () => void>()
  #nextId = 0

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.#nextId
    this.delays.push(delayMs)
    this.callbacks.set(id, callback)
    return id
  }

  clearTimeout(id: unknown): void {
    if (typeof id === "number") this.callbacks.delete(id)
  }

  async runNext(): Promise<void> {
    const next = this.callbacks.entries().next().value as [number, () => void] | undefined
    if (!next) throw new Error("No scheduled reconnect")
    this.callbacks.delete(next[0])
    await Promise.resolve()
    next[1]()
  }
}

describe("DomovoiClient", () => {
  it("preserves typed project switch confirmation data", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting

    const opening = client.openProject("/code/elsewhere")
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32010,
        message: "Confirm removal before switching projects",
        data: {
          kind: "project-switch-confirmation",
          requestedPath: "/code/elsewhere",
          sessions: [{ id: "session-1", title: "Keep this", state: "idle", workspacePath: "/worktrees/session-1" }],
          sessionCount: 1,
          worktreeCount: 1,
        },
      },
    })

    const confirmationError = await opening.catch((cause: unknown) => cause)
    expect(confirmationError).toBeInstanceOf(ProjectSwitchConfirmationError)
    expect(confirmationError).toMatchObject({
      name: "ProjectSwitchConfirmationError",
      confirmation: { requestedPath: "/code/elsewhere", sessionCount: 1 },
    })

    const confirmed = client.openProject(
      "/code/elsewhere",
      (confirmationError as ProjectSwitchConfirmationError).confirmation,
    )
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "project.open",
      params: {
        path: "/code/elsewhere",
        client: "web",
        confirmation: (confirmationError as ProjectSwitchConfirmationError).confirmation,
      },
    })
    socket.receive({ jsonrpc: "2.0", id: 3, result: demoWorkspace })
    await expect(confirmed).resolves.toEqual(demoWorkspace)
    client.disconnect()
  })

  it("reports a protocol error when a notification fails schema validation", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const protocolErrors: string[] = []
    client.addEventListener("protocol-error", (event) => {
      protocolErrors.push((event as CustomEvent<{ reason: string }>).detail.reason)
    })

    socket.receive({ jsonrpc: "2.0", method: "workspace.changed", params: { nonsense: true } })

    expect(protocolErrors).toEqual([
      "Daemon sent a workspace.changed notification this client could not parse",
    ])
    client.disconnect()
  })

  it("reports a protocol error for a notification method it does not recognize", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const protocolErrors: string[] = []
    client.addEventListener("protocol-error", (event) => {
      protocolErrors.push((event as CustomEvent<{ reason: string }>).detail.reason)
    })

    socket.receive({ jsonrpc: "2.0", method: "workspace.invented", params: {} })

    expect(protocolErrors).toEqual([
      "Daemon sent a workspace.invented notification this client does not recognize",
    ])
    client.disconnect()
  })

  it("rejects a pending request immediately when its response cannot be parsed", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const protocolErrors: string[] = []
    client.addEventListener("protocol-error", (event) => {
      protocolErrors.push((event as CustomEvent<{ reason: string }>).detail.reason)
    })

    const listing = client.listModels("codex")
    socket.receive({ id: 2, result: [] })

    await expect(listing).rejects.toThrow(
      "Daemon returned a response this client could not parse",
    )
    expect(protocolErrors).toContain("Daemon sent an RPC response this client could not parse")
    client.disconnect()
  })

  it("announces a scheduled reconnect and clears it once the timer fires", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets, scheduler })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const states: boolean[] = []
    client.addEventListener("reconnecting", (event) => {
      states.push((event as CustomEvent<{ active: boolean }>).detail.active)
    })

    socket.drop(1006)
    expect(states).toEqual([true])
    expect(FakeWebSocket.instances).toHaveLength(1)

    await scheduler.runNext()
    expect(states).toEqual([true, false])
    expect(FakeWebSocket.instances).toHaveLength(2)
    client.disconnect()
  })
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
      budgets,
      reconnectDelayMs: 25,
      reconnectJitterRatio: 0,
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
      budgets,
      authToken: "secret-token",
    })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      method: "system.hello",
      params: {
        client: "web",
        clientId: client.clientId,
        protocolVersion,
        authToken: "secret-token",
      },
    })
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    client.disconnect()
  })

  it("publishes validated workspace deltas", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
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

  it("publishes validated emergency-stopped notifications", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const received: SystemEmergencyStoppedNotification[] = []
    client.addEventListener("emergency-stopped", (event) => {
      received.push((event as CustomEvent<SystemEmergencyStoppedNotification>).detail)
    })
    const result = {
      snapshot: demoWorkspace,
      stopId: "stop-notification-1",
      requestedAt: "2026-08-29T12:00:00.000Z",
      client: "desktop",
      outcomes: {
        turnsStopped: 1,
        terminalsClosed: 1,
        approvalsDenied: 1,
        mutationsCancelled: 1,
        providersReset: 1,
      },
      failures: [],
    }
    socket.receive({
      jsonrpc: "2.0",
      method: "system.emergencyStopped",
      params: result,
    })
    socket.receive({
      jsonrpc: "2.0",
      method: "system.emergencyStopped",
      params: { ...result, outcomes: { turnsStopped: -1 } },
    })

    expect(received).toEqual([result])
    client.disconnect()
  })

  it("requests preview access scoped to the bridge channel", async () => {
    const client = new DomovoiClient("wss://machine.example/rpc", "tablet", { budgets })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting

    const authorizing = client.authorizeArtifact({ sessionId: "session-a", artifactId: "artifact-preview", revision: 2, purpose: "preview", bridgeChannel: "preview_channel_123456", parentOrigin: "https://app.domovoi.sh" })
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "artifact.authorize",
      params: {
        sessionId: "session-a",
        artifactId: "artifact-preview",
        revision: 2,
        purpose: "preview",
        bridgeChannel: "preview_channel_123456",
        parentOrigin: "https://app.domovoi.sh",
        client: "tablet",
      },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessionId: "session-a",
        artifactId: "artifact-preview",
        revision: 2,
        purpose: "preview",
        bridgeChannel: "preview_channel_123456",
        parentOrigin: "https://app.domovoi.sh",
        expiresAt: 1_800_000_000,
        signature: "a".repeat(43),
      },
    })

    await expect(authorizing).resolves.toMatchObject({ artifactId: "artifact-preview", parentOrigin: "https://app.domovoi.sh" })
    client.disconnect()
  })

  it("requests older session history by cursor", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
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

  it("cancels session history through its request signal", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    const controller = new AbortController()

    const loading = client.loadSessionHistory(
      demoWorkspace.sessions[0]!.id,
      { query: "newest", limit: 50 },
      { signal: controller.signal },
    )
    const cancellation = loading.catch((cause: unknown) => cause)
    controller.abort()

    await expect(cancellation).resolves.toMatchObject({ name: "AbortError" })
    expect(vi.getTimerCount()).toBe(0)
    client.disconnect()
  })

  it("requests and validates refreshed session evidence", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
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
      budgets,
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
      budgets,
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
      budgets,
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
      budgets: { ...budgets, requestMs: 50 },
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
      budgets: { ...budgets, requestMs: oversizedTimeoutMs },
    })).toThrow(RangeError)

    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    expect(() => Deadline.start(oversizedTimeoutMs)).toThrow(RangeError)
    client.disconnect()
  })

  it("allows multi-step RPC work until the 120-second default deadline", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
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

  it("attributes provider restart requests to the client", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const restarted = client.restartProviderThread("session-billing")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "session.restartProviderThread",
      params: { sessionId: "session-billing", client: "web" },
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await expect(restarted).resolves.toEqual(demoWorkspace)
    client.disconnect()
  })

  it("ignores a late response without affecting a newer desktop request", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", {
      budgets: { ...budgets, requestMs: 100 },
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
      budgets: { ...budgets, requestMs: 5_000 },
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
      budgets: { ...budgets, requestMs: 5_000 },
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
      budgets: { ...budgets, requestMs: 5_000 },
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
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })

    const connecting = client.connect()
    client.disconnect()

    await expect(connecting).rejects.toThrow("Daemon connection closed")
  })

  it("reuses an in-progress connection attempt", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })

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
      budgets,
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

  it("uses capped exponential reconnect delays with deterministic jitter", async () => {
    const scheduler = new ManualScheduler()
    const randomValues = [0.5, 0, 1, 0.5]
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      budgets,
      reconnectDelayMs: 1_000,
      reconnectMaxDelayMs: 4_000,
      reconnectJitterRatio: 0.2,
      random: () => randomValues.shift() ?? 0.5,
      scheduler,
    })

    client.connect()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      FakeWebSocket.instances.at(-1)!.drop()
      await scheduler.runNext()
    }

    expect(scheduler.delays).toEqual([1_000, 1_600, 4_000, 4_000])
    expect(FakeWebSocket.instances).toHaveLength(5)
    client.disconnect()
  })

  it("resets reconnect backoff only after confirmed authentication", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", {
      budgets,
      reconnectDelayMs: 100,
      reconnectMaxDelayMs: 800,
      reconnectJitterRatio: 0,
      scheduler,
    })

    client.connect()
    FakeWebSocket.instances[0]!.drop()
    await scheduler.runNext()
    const unauthenticated = FakeWebSocket.instances[1]!
    unauthenticated.open()
    unauthenticated.drop()
    await scheduler.runNext()
    const authenticated = FakeWebSocket.instances[2]!
    authenticated.open()
    authenticated.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await Promise.resolve()
    authenticated.drop()

    expect(scheduler.delays).toEqual([100, 200, 100])
    client.disconnect()
  })

  it("starts a fresh connection at the first backoff delay", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets, scheduler, random: () => 0.5 })

    client.connect()
    FakeWebSocket.instances[0]!.drop()
    const firstDelay = scheduler.delays[0]!
    await scheduler.runNext()
    FakeWebSocket.instances[1]!.drop()
    const escalatedDelay = scheduler.delays[1]!
    expect(escalatedDelay).toBeGreaterThan(firstDelay)

    client.disconnect()
    client.connect()
    FakeWebSocket.instances[2]!.drop()

    expect(scheduler.delays[2]).toBe(firstDelay)
  })

  it("stops reconnecting once a machine revokes this device", () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets, scheduler })

    client.connect()
    FakeWebSocket.instances[0]!.drop(1008, "device credential revoked")

    expect(scheduler.callbacks.size).toBe(0)
  })

  it("cancels reconnect work after explicit disconnect", () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets, scheduler })

    client.connect()
    FakeWebSocket.instances[0]!.drop()
    expect(scheduler.callbacks).toHaveLength(1)
    client.disconnect()
    expect(scheduler.callbacks).toHaveLength(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it("publishes terminal authentication rejection without retrying", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", {
      budgets,
      authToken: "expired-token",
      scheduler,
    })
    const authenticationRequired = vi.fn()
    client.addEventListener("authentication-required", authenticationRequired)

    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32001, message: "Daemon authentication failed" },
    })
    await expect(connecting).rejects.toThrow("Daemon authentication failed")

    expect(authenticationRequired).toHaveBeenCalledOnce()
    expect((authenticationRequired.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      message: "Daemon authentication failed",
      action: "update-credentials-or-reconnect",
    })
    expect(scheduler.callbacks).toHaveLength(0)
  })

  it("stops an authenticated connection when credentials expire", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets, scheduler })
    const authenticationRequired = vi.fn()
    client.addEventListener("authentication-required", authenticationRequired)
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting

    const request = client.activateSession("session-audit")
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32001, message: "Daemon authentication expired" },
    })

    await expect(request).rejects.toThrow("Daemon authentication expired")
    expect(authenticationRequired).toHaveBeenCalledOnce()
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(scheduler.callbacks).toHaveLength(0)
  })

  it("does not let stale socket callbacks create or revive a connection", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets, scheduler })

    client.connect()
    const stale = FakeWebSocket.instances[0]!
    stale.drop()
    await scheduler.runNext()
    const current = FakeWebSocket.instances[1]!
    stale.open()
    stale.drop()

    expect(stale.sent).toHaveLength(0)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(scheduler.callbacks).toHaveLength(0)
    expect(current.readyState).toBe(FakeWebSocket.CONNECTING)
    client.disconnect()
  })

  it("retries a 1013 slow-client close", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", {
      budgets,
      reconnectDelayMs: 50,
      reconnectJitterRatio: 0,
      scheduler,
    })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting

    socket.drop(1013, "slow client")

    expect(scheduler.delays).toEqual([50])
    await scheduler.runNext()
    expect(FakeWebSocket.instances).toHaveLength(2)
    client.disconnect()
  })

  it("attributes annotation mutations to the current client", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "tablet", { budgets })
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
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "tablet", { budgets })
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
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "tablet", { budgets })
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
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
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

  it("refreshes provider readiness through an attributed daemon request", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const refreshing = client.refreshProviders()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "provider.refresh",
      params: { client: "desktop" },
    })
    const refreshed = structuredClone(demoWorkspace)
    refreshed.machine.providers = [{
      id: "codex",
      command: "codex",
      status: "ready",
      sessionCapable: true,
    }]
    socket.receive({ jsonrpc: "2.0", id: 2, result: refreshed })
    await expect(refreshing).resolves.toEqual(refreshed)
    client.disconnect()
  })

  it("lists daemon skills without parsing them as workspace state", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
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
        ...skillSecurityMetadata,
      }],
    })

    await expect(listing).resolves.toEqual([
      expect.objectContaining({ name: "repo-audit", source: "agents" }),
    ])
    client.disconnect()
  })

  it("fetches only metadata for fleet skill comparison", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const request = client.getSkillInventory()
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "skill.inventory",
      params: {},
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: {
        machine: { id: "machine-local", name: "devbox", platform: "linux", arch: "x64", version: "0.0.1" },
        skills: [{
          id: "skill-4d6f4d6f4d6f",
          name: "repo-audit",
          scope: "user",
          source: "agents",
          manifest: { version: 1, capabilities: [] },
          contentDigest: `sha256:${"a".repeat(64)}`,
          signature: { state: "unsigned" },
          trust: { state: "untrusted", reason: "unsigned" },
        }],
      },
    })
    await expect(request).resolves.toMatchObject({ machine: { id: "machine-local" } })
    expect(socket.sent).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/skill\.(?:install|copy|sync|distribute)/),
    ]))
    client.disconnect()
  })

  it("manages provider keychain status without returning secret material", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const listing = client.listProviderSecrets()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ method: "provider.secret.list", params: {} })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: [{ provider: "openai", state: "not-set", source: "keychain" }],
    })
    await expect(listing).resolves.toEqual([
      { provider: "openai", state: "not-set", source: "keychain" },
    ])

    expect(socket.sent).not.toEqual(expect.arrayContaining([
      expect.stringContaining("provider.secret.set"),
      expect.stringContaining("provider.secret.delete"),
    ]))
    client.disconnect()
  })

  it("asks the daemon for session token and cost totals", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const usage = client.sessionUsage("session-1")
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "session.usage",
      params: { sessionId: "session-1" },
    })
    socket.receive({
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessionId: "session-1",
        inputTokens: 900,
        cachedInputTokens: 100,
        outputTokens: 300,
        reasoningTokens: 0,
        totalTokens: 1200,
        costMicros: 4500,
        currency: "USD",
        reportedCostTurns: 1,
        unavailableCostTurns: 2,
        byRuntime: [{
          provider: "codex",
          model: "gpt-5.6-sol",
          inputTokens: 900,
          cachedInputTokens: 100,
          outputTokens: 300,
          reasoningTokens: 0,
          totalTokens: 1200,
          costMicros: 4500,
          currency: "USD",
          turns: 3,
        }],
      },
    })
    await expect(usage).resolves.toMatchObject({
      totalTokens: 1200,
      reportedCostTurns: 1,
      unavailableCostTurns: 2,
    })
    client.disconnect()
  })

  it("reads skill source by discovered ID", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
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
          ...skillSecurityMetadata,
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

  it("submits exact skill review evidence without client spoofing", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const update = client.setSkillEnabled({
      id: "skill-4d6f4d6f4d6f",
      enabled: true,
      contentDigest: `sha256:${"a".repeat(64)}`,
      manifest: { version: 1, capabilities: ["filesystem.read"] },
    })
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "skill.setEnabled",
      params: {
        id: "skill-4d6f4d6f4d6f",
        enabled: true,
        contentDigest: `sha256:${"a".repeat(64)}`,
        manifest: { version: 1, capabilities: ["filesystem.read"] },
      },
    })
    expect(socket.sent.at(-1)).not.toContain("clientId")
    socket.receive({ jsonrpc: "2.0", id: 2, result: demoWorkspace })
    await expect(update).resolves.toEqual(demoWorkspace)
    client.disconnect()
  })

  it("queries and exports typed audit records with bounded request controls", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
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
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
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
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "desktop", { budgets })
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
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "phone", { budgets })
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

  it("attributes the emergency stop to the current client", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "phone", { budgets })
    const initial = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await initial

    const result = {
      snapshot: demoWorkspace,
      stopId: "stop-1",
      requestedAt: "2026-08-29T12:00:00.000Z",
      client: "phone",
      outcomes: {
        turnsStopped: 1,
        terminalsClosed: 2,
        approvalsDenied: 3,
        mutationsCancelled: 4,
        providersReset: 2,
      },
      failures: [],
    } as const
    const stopping = client.emergencyStop()
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      method: "system.emergencyStop",
      params: { client: "phone" },
    })
    socket.receive({ jsonrpc: "2.0", id: 2, result })
    await expect(stopping).resolves.toEqual(result)
    client.disconnect()
  })

  it("attributes session archive to the shared client kind", async () => {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
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

describe("DomovoiClient fleet enrollment", () => {
  const NativeWebSocket = globalThis.WebSocket
  const machineId = `machine-${"c".repeat(32)}`
  const remote = {
    id: machineId,
    label: "workshop",
    platform: "linux",
    arch: "x64",
    version: "0.4.2",
    capabilities: ["sessions"],
    protocolVersion,
    transports: [],
    connection: "direct",
    verifiedRoute: {
      endpoint: "wss://workshop.tailnet:47831/rpc",
      lastAuthenticatedAt: "2026-09-04T12:00:00.000Z",
    },
    heartbeat: { state: "online", lastSeenAt: "2026-09-04T12:00:00.000Z" },
    health: "healthy",
    self: false,
  }

  beforeEach(() => {
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = NativeWebSocket
  })

  async function connected() {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    return { client, socket }
  }

  it("lists the fleet through the daemon", async () => {
    const { client, socket } = await connected()

    const listing = client.listFleet()
    const sent = JSON.parse(socket.sent[1]!) as { id: number; method: string; params: unknown }
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { entries: [] } })

    await expect(listing).resolves.toEqual({ entries: [] })
    expect(sent.method).toBe("fleet.list")
    expect(sent.params).toEqual({})
  })

  it("enrolls a machine through the daemon as the client it greeted as", async () => {
    const { client, socket } = await connected()

    const enrolling = client.enrollMachine({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code: "hearth-quiet-ember-42",
      sourceDeviceLabel: "studio-desktop",
    })
    const sent = JSON.parse(socket.sent[1]!) as { id: number; method: string; params: unknown }
    socket.receive({
      jsonrpc: "2.0",
      id: sent.id,
      result: { outcome: "enrolled", machineId, fleet: { entries: [{ kind: "machine", machine: remote }] } },
    })

    await expect(enrolling).resolves.toMatchObject({ outcome: "enrolled", machineId })
    expect(sent.method).toBe("fleet.enroll")
    expect(sent.params).toEqual({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code: "hearth-quiet-ember-42",
      sourceDeviceLabel: "studio-desktop",
      client: "web",
    })
  })

  it("rejects an enrollment answer the protocol does not describe", async () => {
    const { client, socket } = await connected()

    const enrolling = client.enrollMachine({
      endpoint: "wss://workshop.tailnet:47831/rpc",
      code: "hearth-quiet-ember-42",
      sourceDeviceLabel: "studio-desktop",
    })
    const sent = JSON.parse(socket.sent[1]!) as { id: number }
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { outcome: "enrolled", machineId, fleet: { entries: [] } } })

    await expect(enrolling).rejects.toThrow()
  })

  it("forgets a machine through the daemon and keeps the revocation verdict", async () => {
    const { client, socket } = await connected()

    const forgetting = client.forgetMachine({ machineId })
    const sent = JSON.parse(socket.sent[1]!) as { id: number; method: string; params: unknown }
    socket.receive({
      jsonrpc: "2.0",
      id: sent.id,
      result: { outcome: "forgotten", machineId, remoteRevocation: "unconfirmed", fleet: { entries: [] } },
    })

    await expect(forgetting).resolves.toEqual({
      outcome: "forgotten",
      machineId,
      remoteRevocation: "unconfirmed",
      fleet: { entries: [] },
    })
    expect(sent.method).toBe("fleet.forget")
    expect(sent.params).toEqual({ machineId, client: "web" })
  })

  it("keeps the daemon's typed error data on a refused listing", async () => {
    const { client, socket } = await connected()

    const listing = client.listFleet()
    const sent = JSON.parse(socket.sent[1]!) as { id: number }
    socket.receive({
      jsonrpc: "2.0",
      id: sent.id,
      error: {
        code: fleetSnapshotOverflowErrorCode,
        message: "Fleet keyring exceeds the wire limit",
        data: { kind: "fleet-overflow", limit: maximumFleetEntries, totalEntries: 600, entriesNotShown: 600 },
      },
    })

    const failure = await listing.then(() => undefined, (cause: unknown) => cause)
    expect(failure).toBeInstanceOf(DaemonRpcError)
    expect((failure as DaemonRpcError).code).toBe(fleetSnapshotOverflowErrorCode)
    expect((failure as DaemonRpcError).data)
      .toEqual({ kind: "fleet-overflow", limit: maximumFleetEntries, totalEntries: 600, entriesNotShown: 600 })
  })

  it("replaces the fleet when the daemon says it changed", async () => {
    const { client, socket } = await connected()
    const changes: unknown[] = []
    client.addEventListener("fleet-changed", (event) => {
      changes.push((event as CustomEvent).detail)
    })

    socket.receive({
      jsonrpc: "2.0",
      method: "fleet.changed",
      params: { entries: [{ kind: "unenrolled", machineId }] },
    })

    expect(changes).toEqual([{ entries: [{ kind: "unenrolled", machineId }] }])
  })

  it("reports a fleet.changed notification it cannot parse", async () => {
    const { client, socket } = await connected()
    const protocolErrors: string[] = []
    client.addEventListener("protocol-error", (event) => {
      protocolErrors.push((event as CustomEvent<{ reason: string }>).detail.reason)
    })

    socket.receive({ jsonrpc: "2.0", method: "fleet.changed", params: { machines: [] } })

    expect(protocolErrors).toEqual([
      "Daemon sent a fleet.changed notification this client could not parse",
    ])
  })
})

describe("DomovoiClient session transfer and devices", () => {
  const NativeWebSocket = globalThis.WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = NativeWebSocket
  })

  async function connected() {
    const client = new DomovoiClient("ws://127.0.0.1:47831/rpc", "web", { budgets })
    const connecting = client.connect()
    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    return { client, socket }
  }

  it("moves a session with a bundle by default", async () => {
    const { client, socket } = await connected()

    const moving = client.transferSession({
      contractVersion: 1,
      intentDigest: `sha256:${"a".repeat(64)}`,
      sessionId: "session-billing",
      targetMachineId: `machine-${"b".repeat(32)}`,
      method: "git-bundle",
    })
    const sent = JSON.parse(socket.sent[1]!) as { id: number; method: string; params: unknown }
    socket.receive({
      jsonrpc: "2.0",
      id: sent.id,
      result: {
        outcome: "succeeded",
        workspacePath: "/worktrees/session-billing",
        checkpointCommit: "c".repeat(40),
        contractVersion: 1,
        transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ownershipGeneration: 2,
        coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
      },
    })

    await expect(moving).resolves.toEqual({
      outcome: "succeeded",
      workspacePath: "/worktrees/session-billing",
      checkpointCommit: "c".repeat(40),
      contractVersion: 1,
      transferId: "transfer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ownershipGeneration: 2,
      coverage: { included: [{ kind: "repository" }], excluded: [], warnings: [] },
    })
    expect(sent.method).toBe("session.transfer")
    expect(sent.params).toEqual({
      contractVersion: 1,
      intentDigest: `sha256:${"a".repeat(64)}`,
      sessionId: "session-billing",
      targetMachineId: `machine-${"b".repeat(32)}`,
      method: "git-bundle",
      initiatedByClient: "web",
    })
    client.disconnect()
  })

  it("moves a session over a named remote when asked to", async () => {
    const { client, socket } = await connected()

    const moving = client.transferSession({
      contractVersion: 1,
      intentDigest: `sha256:${"a".repeat(64)}`,
      sessionId: "session-billing",
      targetMachineId: `machine-${"b".repeat(32)}`,
      method: "remote-ref",
      remote: "origin",
    })
    const sent = JSON.parse(socket.sent[1]!) as { id: number; params: unknown }
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { outcome: "refused", reason: "target-unreachable" } })

    await expect(moving).resolves.toEqual({ outcome: "refused", reason: "target-unreachable" })
    expect(sent.params).toEqual({
      contractVersion: 1,
      intentDigest: `sha256:${"a".repeat(64)}`,
      sessionId: "session-billing",
      targetMachineId: `machine-${"b".repeat(32)}`,
      method: "remote-ref",
      remote: "origin",
      initiatedByClient: "web",
    })
    client.disconnect()
  })

  it("lists paired devices through the daemon", async () => {
    const { client, socket } = await connected()

    const listing = client.listDevices()
    const sent = JSON.parse(socket.sent[1]!) as { id: number; method: string; params: unknown }
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { devices: [] } })

    await expect(listing).resolves.toEqual({ devices: [] })
    expect(sent.method).toBe("device.list")
    expect(sent.params).toEqual({})
    client.disconnect()
  })

  it("revokes a paired device through the daemon", async () => {
    const { client, socket } = await connected()
    const device = {
      id: `device-${"d".repeat(32)}`,
      label: "studio-ipad",
      pairedAt: "2026-08-31T12:00:00.000Z",
      binding: { kind: "client", client: "tablet" },
      revokedAt: "2026-09-01T12:00:00.000Z",
    }

    const revoking = client.revokeDevice({ deviceId: device.id })
    const sent = JSON.parse(socket.sent[1]!) as { id: number; method: string; params: unknown }
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { device } })

    await expect(revoking).resolves.toEqual({ device })
    expect(sent.method).toBe("device.revoke")
    expect(sent.params).toEqual({ deviceId: device.id, client: "web" })
    client.disconnect()
  })

  it("renames a paired device with only its id and new label", async () => {
    const { client, socket } = await connected()
    const device = {
      id: `device-${"d".repeat(32)}`,
      label: "kitchen-ipad",
      pairedAt: "2026-08-31T12:00:00.000Z",
      binding: { kind: "client", client: "tablet" },
    }

    const renaming = client.renameDevice({ deviceId: device.id, label: "kitchen-ipad" })
    const sent = JSON.parse(socket.sent[1]!) as { id: number; method: string; params: unknown }
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { device } })

    await expect(renaming).resolves.toEqual({ device })
    expect(sent.method).toBe("device.rename")
    expect(sent.params).toEqual({ deviceId: device.id, label: "kitchen-ipad" })
    client.disconnect()
  })

  it("rotates a paired device credential through the daemon", async () => {
    const { client, socket } = await connected()
    const device = {
      id: `device-${"e".repeat(32)}`,
      label: "studio-ipad",
      pairedAt: "2026-08-31T12:00:00.000Z",
      binding: { kind: "client", client: "tablet" },
    }

    const rotating = client.rotateDevice({ deviceId: device.id })
    const sent = JSON.parse(socket.sent[1]!) as { id: number; method: string; params: unknown }
    socket.receive({ jsonrpc: "2.0", id: sent.id, result: { device, token: "f".repeat(43) } })

    await expect(rotating).resolves.toEqual({ device, token: "f".repeat(43) })
    expect(sent.method).toBe("device.rotate")
    expect(sent.params).toEqual({ deviceId: device.id, client: "web" })
    client.disconnect()
  })
})

describe("DomovoiClient deadlines", () => {
  const NativeWebSocket = globalThis.WebSocket
  const url = "ws://127.0.0.1:47831/rpc"
  const budgets = { connectMs: 1_000, requestMs: 5_000 }

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    globalThis.WebSocket = NativeWebSocket
    vi.useRealTimers()
  })

  async function handshake(client: DomovoiClient): Promise<FakeWebSocket> {
    const connecting = client.connect()
    const socket = FakeWebSocket.instances.at(-1)!
    socket.open()
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await connecting
    return socket
  }

  it("requires finite positive budgets", () => {
    expect(() => new DomovoiClient(url, "web", { budgets: { connectMs: 0, requestMs: 1 } })).toThrow(RangeError)
    expect(() => new DomovoiClient(url, "web", { budgets: { connectMs: 1, requestMs: Number.NaN } })).toThrow(RangeError)
  })

  it("fails a socket that never opens at the connect budget and frees the attempt", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient(url, "web", { budgets, scheduler })
    const disconnected = vi.fn()
    client.addEventListener("disconnected", disconnected)
    const connecting = client.connect()
    const outcome = connecting.catch((cause: unknown) => cause)
    let settled = false
    void outcome.then(() => {
      settled = true
    })
    const socket = FakeWebSocket.instances[0]!

    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(outcome).resolves.toBeInstanceOf(DomovoiConnectTimeoutError)
    await expect(outcome).resolves.toMatchObject({
      name: "DomovoiConnectTimeoutError",
      stage: "open",
      target: url,
      budgetMs: 1_000,
    })
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(disconnected).toHaveBeenCalledOnce()
    expect(scheduler.callbacks.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    client.disconnect()
    expect(scheduler.callbacks.size).toBe(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it("counts the hello against the budget the open already spent", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient(url, "web", { budgets, scheduler })
    const snapshot = vi.fn()
    const connected = vi.fn()
    client.addEventListener("snapshot", snapshot)
    client.addEventListener("connected", connected)
    const outcome = client.connect().catch((cause: unknown) => cause)
    const socket = FakeWebSocket.instances[0]!

    await vi.advanceTimersByTimeAsync(900)
    socket.open()
    expect(socket.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)

    await expect(outcome).resolves.toMatchObject({ stage: "hello", budgetMs: 1_000 })
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(vi.getTimerCount()).toBe(0)

    socket.readyState = FakeWebSocket.OPEN
    socket.receive({ jsonrpc: "2.0", id: 1, result: demoWorkspace })
    await Promise.resolve()
    expect(snapshot).not.toHaveBeenCalled()
    expect(connected).not.toHaveBeenCalled()
    await expect(client.activateSession("session-audit")).rejects.toThrow("Daemon connection is not open")
    client.disconnect()
  })

  it("gives the next attempt its own full budget", async () => {
    const scheduler = new ManualScheduler()
    const client = new DomovoiClient(url, "web", { budgets, scheduler })
    void client.connect().catch(() => undefined)
    const stale = FakeWebSocket.instances[0]!
    await vi.advanceTimersByTimeAsync(1_000)
    expect(stale.readyState).toBe(FakeWebSocket.CLOSED)

    await scheduler.runNext()
    const current = FakeWebSocket.instances[1]!
    stale.open()
    expect(stale.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(current.readyState).toBe(FakeWebSocket.CONNECTING)
    await vi.advanceTimersByTimeAsync(1)

    expect(current.readyState).toBe(FakeWebSocket.CLOSED)
    expect(scheduler.callbacks.size).toBe(1)
    client.disconnect()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("lets a connect share a caller's deadline and keeps its own cap", async () => {
    const client = new DomovoiClient(url, "web", { budgets: { connectMs: 1_000, requestMs: 5_000 } })
    const deadline = Deadline.start(10_000)
    await vi.advanceTimersByTimeAsync(9_700)

    const outcome = client.connect(deadline).catch((cause: unknown) => cause)
    await vi.advanceTimersByTimeAsync(300)

    await expect(outcome).resolves.toMatchObject({ stage: "open", budgetMs: 300 })
    expect(deadline.expired).toBe(true)
    client.disconnect()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects a request at the caller's deadline and ignores the late answer", async () => {
    const client = new DomovoiClient(url, "web", { budgets })
    const socket = await handshake(client)
    const deadline = Deadline.start(200)

    const expired = client.request(
      "session.activate",
      { sessionId: "session-audit", client: "web" },
      { deadline },
    )
    const expiration = expired.catch((cause: unknown) => cause)
    await vi.advanceTimersByTimeAsync(200)

    await expect(expiration).resolves.toBeInstanceOf(DomovoiRpcTimeoutError)
    await expect(expiration).resolves.toMatchObject({ method: "session.activate", timeoutMs: 200 })
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

  it("holds a request to the client budget when the caller allows longer", async () => {
    const client = new DomovoiClient(url, "web", { budgets })
    await handshake(client)
    const deadline = Deadline.start(60_000)

    const expiration = client.request("skill.list", {}, { deadline }).catch((cause: unknown) => cause)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(expiration).resolves.toMatchObject({ method: "skill.list", timeoutMs: 5_000 })
    expect(deadline.expired).toBe(false)
    deadline.clear()
    client.disconnect()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("refuses to send a request whose deadline has already passed", async () => {
    const client = new DomovoiClient(url, "web", { budgets })
    const socket = await handshake(client)
    const deadline = Deadline.start(100)
    await vi.advanceTimersByTimeAsync(100)

    await expect(client.request("skill.list", {}, { deadline })).rejects.toBeInstanceOf(DomovoiRpcTimeoutError)
    expect(socket.sent).toHaveLength(1)
    client.disconnect()
  })
})
