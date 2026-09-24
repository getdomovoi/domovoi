import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace } from "@getdomovoi/protocol"
import { act, renderHook } from "@testing-library/react-native"
import { AppState, type AppStateStatus } from "react-native"

import { useDaemon } from "./use-daemon"

jest.mock("./credentials", () => ({ openRelayPinStore: () => ({}) }))
jest.mock("./relay-pin", () => ({ reconcileRelayPin: () => Promise.resolve() }))

class FakeSocket {
  static made: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.made.push(this) }
  send(payload: string) { this.sent.push(payload) }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  answerHello(result: unknown = demoWorkspace) {
    const hello = JSON.parse(this.sent[0]!) as { id: number }
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: hello.id, result }) })
  }
  push(method: string, params: unknown) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) })
  }
}

const original = Reflect.get(globalThis, "WebSocket") as unknown
let appStateListener: ((state: AppStateStatus) => void) | undefined

beforeEach(() => {
  FakeSocket.made = []
  Reflect.set(globalThis, "WebSocket", FakeSocket)
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appStateListener = listener as (state: AppStateStatus) => void
    return { remove: () => { appStateListener = undefined } } as ReturnType<typeof AppState.addEventListener>
  })
})

afterEach(() => {
  Reflect.set(globalThis, "WebSocket", original)
  jest.restoreAllMocks()
})

const sessionId = demoWorkspace.sessions[0]!.id
const delta = {
  sessionId,
  updatedAt: "2026-09-22T12:00:00.000Z",
  operations: [{ kind: "assistant.append", id: "streamed-1", delta: "once", createdAt: "2026-09-22T12:00:00.000Z" }],
}

function streamed(snapshot: typeof demoWorkspace | undefined): string | undefined {
  const item = snapshot?.thread.find((candidate) => candidate.id === "streamed-1")
  return item && "body" in item ? item.body : undefined
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe("useDaemon", () => {
  it("keeps one connection when the app wakes while a dial is still connecting", async () => {
    const { result, unmount } = await renderHook(() => useDaemon("ws://desk:8787/rpc", "token", "phone", () => {}))
    expect(FakeSocket.made).toHaveLength(1)

    await act(async () => { appStateListener?.("active") })
    await act(async () => { result.current.reconnect() })
    expect(FakeSocket.made).toHaveLength(1)

    const socket = FakeSocket.made[0]!
    await act(async () => { socket.open() })
    await act(async () => { socket.answerHello() })
    await flush()
    await act(async () => { socket.push("workspace.delta", delta) })
    expect(streamed(result.current.snapshot)).toBe("once")
    await unmount()
  })

  it("ignores a replaced connection, so its close cannot turn the live one into watching", async () => {
    const { result, unmount } = await renderHook(() => useDaemon("ws://desk:8787/rpc", "token", "phone", () => {}))
    const first = FakeSocket.made[0]!
    await act(async () => { first.open() })
    await act(async () => { first.answerHello({ ...demoWorkspace, clientAccess: "full" }) })
    await flush()
    // The socket drops without a close event reaching the app yet, as a
    // phone's radio does, and the app wakes and dials again.
    first.readyState = 3
    await act(async () => { appStateListener?.("active") })
    expect(FakeSocket.made).toHaveLength(2)
    const second = FakeSocket.made[1]!
    await act(async () => { second.open() })
    await act(async () => { second.answerHello({ ...demoWorkspace, clientAccess: "full" }) })
    await flush()
    expect(result.current.clientAccess).toBe("full")

    await act(async () => { first.onclose?.() })
    await act(async () => { first.push("workspace.delta", delta) })
    expect(result.current.status).toBe("open")
    expect(result.current.clientAccess).toBe("full")
    expect(streamed(result.current.snapshot)).toBeUndefined()
    await unmount()
  })

  function refuseHello(socket: FakeSocket) {
    const hello = JSON.parse(socket.sent[0]!) as { id: number }
    socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: hello.id, error: { code: -32001, message: "Paired client credential does not match this client" } }) })
  }

  function greetedAs(socket: FakeSocket): unknown {
    return (JSON.parse(socket.sent[0]!) as { params: { client: unknown } }).params.client
  }

  // A tablet paired before the app kept the kind stored a credential that
  // greets as a phone and is refused. Such a credential gets one try as a
  // tablet, and the kind that works is kept.
  it("tries a credential of unknown kind as a tablet once, and keeps the kind the daemon accepted", async () => {
    const learned = jest.fn<(kind: "phone" | "tablet") => void>()
    const { result, unmount } = await renderHook(() => useDaemon("ws://desk:8787/rpc", "token", undefined, () => {}, learned))
    const first = FakeSocket.made[0]!
    await act(async () => { first.open() })
    expect(greetedAs(first)).toBe("phone")
    await act(async () => { refuseHello(first) })
    await flush()

    expect(FakeSocket.made).toHaveLength(2)
    const second = FakeSocket.made[1]!
    await act(async () => { second.open() })
    expect(greetedAs(second)).toBe("tablet")
    await act(async () => { second.answerHello() })
    await flush()

    expect(result.current.status).toBe("open")
    expect(result.current.fault).toBeUndefined()
    expect(result.current.client).toBe("tablet")
    expect(learned).toHaveBeenCalledWith("tablet")
    await unmount()
  })

  it("does not guess for a credential whose kind is stored", async () => {
    const { result, unmount } = await renderHook(() => useDaemon("ws://desk:8787/rpc", "token", "phone", () => {}))
    const first = FakeSocket.made[0]!
    await act(async () => { first.open() })
    await act(async () => { refuseHello(first) })
    await flush()

    expect(FakeSocket.made).toHaveLength(1)
    expect(result.current.fault?.retriable).toBe(false)
    await unmount()
  })

  it("says the credential was refused once both kinds were", async () => {
    const learned = jest.fn<(kind: "phone" | "tablet") => void>()
    const { result, unmount } = await renderHook(() => useDaemon("ws://desk:8787/rpc", "token", undefined, () => {}, learned))
    await act(async () => { FakeSocket.made[0]!.open() })
    await act(async () => { refuseHello(FakeSocket.made[0]!) })
    await flush()
    await act(async () => { FakeSocket.made[1]!.open() })
    await act(async () => { refuseHello(FakeSocket.made[1]!) })
    await flush()

    expect(FakeSocket.made).toHaveLength(2)
    expect(result.current.fault?.headline).toBe("The daemon refused this credential")
    expect(learned).not.toHaveBeenCalled()
    await unmount()
  })
})

