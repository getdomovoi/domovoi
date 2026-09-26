import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals"
import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { act, fireEvent, render, screen } from "@testing-library/react-native"

import { App } from "./app"
import { ThemeProvider } from "./theme/theme-provider"

// The phone's root: a stored credential is restored, the daemon is reached
// over a socket this test drives, and each assertion reads the frames the app
// sent, which is what the daemon would act on.

const mockHeld = new Map<string, string>()

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => mockHeld.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockHeld.set(key, value) },
  deleteItemAsync: async (key: string) => { mockHeld.delete(key) },
}))

// The app draws its own SafeAreaProvider, which waits for native insets that a
// test never reports. The library's own mock supplies them.
jest.mock("react-native-safe-area-context", () => jest.requireActual<{ default: unknown }>("react-native-safe-area-context/jest/mock").default)

// NativeWind compiles the stylesheet at build time; a test has nothing to load.
jest.mock("./global.css", () => ({}))

// The preview screen's web view is native. Nothing here opens a preview.
jest.mock("react-native-webview", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native")
  return { WebView: View }
})

jest.mock("./lib/relay-pin", () => ({
  createRelayPinStore: () => ({}),
  reconcileRelayPin: () => Promise.resolve("trusted"),
}))

type Frame = { jsonrpc: "2.0", id: number, method: string, params: Record<string, unknown> }

class FakeSocket {
  static made: FakeSocket[] = []
  readyState = 0
  sent: Frame[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { FakeSocket.made.push(this) }
  send(payload: string) { this.sent.push(JSON.parse(payload) as Frame) }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
  requests(method: string): Frame[] {
    return this.sent.filter((frame) => frame.method === method)
  }
  answer(method: string, result: unknown) {
    const request = this.requests(method).at(-1)
    if (!request) throw new Error(`nothing asked for ${method}`)
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) })
  }
  push(method: string, params: unknown) {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) })
  }
}

const original = Reflect.get(globalThis, "WebSocket") as unknown

beforeEach(() => {
  FakeSocket.made = []
  mockHeld.clear()
  mockHeld.set("domovoi.daemon.url", "wss://desk.example.ts.net:47831/rpc")
  mockHeld.set("domovoi.daemon.token", "t".repeat(43))
  mockHeld.set("domovoi.daemon.client", "phone")
  Reflect.set(globalThis, "WebSocket", FakeSocket)
})

afterEach(() => {
  Reflect.set(globalThis, "WebSocket", original)
})

function workspace(): WorkspaceSnapshot {
  return structuredClone(demoWorkspace)
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

// Restores the stored credential and answers the greeting with this snapshot.
async function openApp(snapshot: WorkspaceSnapshot, clientAccess: "full" | "watching" = "full") {
  const view = await render(<ThemeProvider><App /></ThemeProvider>)
  await settle()
  const socket = FakeSocket.made.at(-1)
  if (!socket) throw new Error("the app did not dial the stored daemon")
  await act(async () => {
    socket.readyState = 1
    socket.onopen?.()
  })
  expect(socket.requests("system.hello")[0]?.params).toMatchObject({ client: "phone", authToken: "t".repeat(43) })
  await act(async () => { socket.answer("system.hello", { ...snapshot, clientAccess }) })
  await settle()
  return { view, socket }
}

const billing = demoWorkspace.sessions.find((session) => session.id === "session-billing")!
const audit = demoWorkspace.sessions.find((session) => session.id === "session-audit")!
const approval = demoWorkspace.approvals[0]!

describe("App", () => {
  it("answers the gate it opened with one approval.resolve carrying that approval's id", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    await settle()

    const sent = socket.requests("approval.resolve")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.params).toMatchObject({ approvalId: approval.id, decision: "allow-once", revision: 0 })
  })

  // Round 4 on #545: the daemon rewrites a file card when the file it reaches
  // moves, and refuses an Allow that names the card as it was. The phone shows
  // the card it was last sent and answers with that card's revision.
  it("shows the file a rewritten gate reaches and answers with the revision it shows", async () => {
    const raised = workspace()
    raised.approvals[0]!.command = "Edit"
    raised.approvals[0]!.affects = "The file one/file in the session worktree."
    const { socket } = await openApp(raised)
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    expect(screen.getByText("The file one/file in the session worktree.")).toBeOnTheScreen()

    const rewritten = structuredClone(raised)
    rewritten.approvals[0]!.affects = "The file two/file in the session worktree."
    rewritten.approvals[0]!.revision = 1
    await act(async () => { socket.push("workspace.changed", rewritten) })
    await settle()
    expect(screen.getByText("The file two/file in the session worktree.")).toBeOnTheScreen()
    expect(screen.queryByText("The file one/file in the session worktree.")).toBeNull()

    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    await settle()
    expect(socket.requests("approval.resolve").map((frame) => frame.params)).toEqual([
      { approvalId: approval.id, decision: "allow-once", revision: 1 },
    ])
  })

  it("names the revision of the gate it denies with a reason", async () => {
    const raised = workspace()
    raised.approvals[0]!.revision = 2
    const { socket } = await openApp(raised)
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Deny" }))
    await fireEvent.changeText(screen.getByLabelText("Reason sent to the agent"), "Use staging first")
    await fireEvent.press(screen.getByRole("button", { name: "Send denial" }))
    await settle()
    expect(socket.requests("approval.resolve").map((frame) => frame.params)).toEqual([
      { approvalId: approval.id, decision: "deny-explain", explanation: "Use staging first", revision: 2 },
    ])
  })

  it("keeps the gate on screen with the reason when the daemon refuses the answer", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Allow once" }))
    const request = socket.requests("approval.resolve")[0]!
    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "The approval store is unavailable" } }) })
    })
    await settle()

    expect(screen.getByRole("button", { name: "Allow once" })).toBeOnTheScreen()
    expect(screen.getByText(/The approval store is unavailable/)).toBeOnTheScreen()
  })

  it("closes the reason screen when another device answers the gate", async () => {
    const { socket } = await openApp(workspace())
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    await fireEvent.press(screen.getByRole("button", { name: "Deny" }))
    expect(screen.getByLabelText("Reason sent to the agent")).toBeOnTheScreen()

    const answered = workspace()
    answered.approvals = []
    await act(async () => { socket.push("workspace.changed", answered) })
    await settle()

    expect(screen.queryByLabelText("Reason sent to the agent")).toBeNull()
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()

    // The next gate opens on its own decision, not on the reason written for
    // the one that was answered elsewhere.
    const next = workspace()
    next.approvals = [{ ...approval, id: "approval-next" }]
    await act(async () => { socket.push("workspace.changed", next) })
    await settle()
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))
    expect(screen.getByRole("button", { name: "Allow once" })).toBeOnTheScreen()
    expect(screen.queryByLabelText("Reason sent to the agent")).toBeNull()
  })

  it("drops the gate when the daemon says this credential only watches", async () => {
    await openApp(workspace(), "watching")
    await fireEvent.press(screen.getByRole("button", { name: billing.title }))

    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull()
    expect(screen.getByText("Watching only. A device paired with full access answers this gate.")).toBeOnTheScreen()
  })

  it("sends one turn for a double tap on Send", async () => {
    const snapshot = workspace()
    const idle = snapshot.sessions.find((session) => session.id === audit.id)!
    idle.workspacePath = "/worktrees/repo-audit"
    idle.providerThreadId = "provider-thread-audit"
    const { socket } = await openApp(snapshot)
    await fireEvent.press(screen.getByRole("button", { name: audit.title }))
    await fireEvent.changeText(screen.getByLabelText("Reply to this session"), "Check the lockfile too")
    const send = screen.getByRole("button", { name: "Send" })
    await act(async () => {
      fireEvent.press(send)
      fireEvent.press(send)
    })
    await settle()

    const sent = socket.requests("session.send")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.params).toMatchObject({ sessionId: audit.id, prompt: "Check the lockfile too", client: "phone" })
  })
})
