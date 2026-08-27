import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { DomovoiClient } from "./client"

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
})
