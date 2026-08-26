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
    this.dispatchEvent(new CloseEvent("close"))
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
    this.dispatchEvent(new CloseEvent("close"))
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
})
