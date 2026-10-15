import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  notify,
  pendingRequest,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocket,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"
import type { DesktopWindowBridge } from "./desktop-platform"

// Opening a session is the one read the thread waits on: session.activate
// answers with the workspace whose thread is that session's. When it ends
// without an answer (no answer in time, the connection closed, an answer the
// client cannot read), the thread column draws the failed-read state for the
// session that was asked for, never the previous session's thread under it.
// The shell's alert says every failed open as well, as it does on any view,
// so no path can leave a failure unsaid. A daemon that answers and refuses
// has answered: that is in the alert only.

let harness: FakeWebSocketHarness

beforeEach(() => {
  try {
    localStorage.removeItem(workspaceUiStorageKey)
  } catch {
    // A browser without storage starts from the default layout anyway.
  }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const previousLine = "The first session's own line"

function twoSessions() {
  const base = workspaceSnapshot()
  const active = base.sessions.find((session) => session.id === base.activeSessionId)!
  const other = base.sessions.find((session) => session.id !== base.activeSessionId)!
  const snapshot = workspaceSnapshot({
    thread: [
      ...base.thread,
      { id: "previous-line", sessionId: active.id, kind: "system", body: previousLine, createdAt: "2026-10-14T09:00:00.000Z" },
    ],
  })
  return { snapshot, active, other }
}

async function openShell(props: Parameters<typeof WorkspaceShell>[0] = {}, timers?: { advanceTimers: (ms: number) => unknown }) {
  const user = userEvent.setup(timers ?? {})
  const fixture = twoSessions()
  render(<WorkspaceShell {...props} />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, fixture.snapshot) })
  await settle()
  expect(screen.getByText(previousLine)).toBeTruthy()
  return { user, socket, ...fixture }
}

async function pickSession(user: ReturnType<typeof userEvent.setup>, title: string) {
  // The list may still be open from the pick before.
  const sessions = screen.queryByRole("button", { name: /^Sessions \d/ })
  if (sessions) await user.click(sessions)
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title.slice(0, 24)}`) }))
  await settle()
}

// An answer the client cannot parse: the daemon said something, but not a
// workspace this client can draw.
function answerUnreadably(socket: FakeWebSocket) {
  const request = pendingRequest(socket, "session.activate")
  socket.answered.add(request.id)
  socket.receive({ jsonrpc: "2.0", id: request.id, result: { unreadable: true } })
}

// An answer whose envelope does not parse: it names the request but carries
// neither a result nor an error.
function answerWithoutEnvelope(socket: FakeWebSocket) {
  const request = pendingRequest(socket, "session.activate")
  socket.answered.add(request.id)
  socket.receive({ jsonrpc: "2.0", id: request.id })
}

const failedRead = () => screen.getByRole("region", { name: "Could not read this session" })

// A desktop bridge whose notification clicks the test makes.
function notifyingBridge() {
  let listener: ((sessionId: string) => void) | undefined
  const windowBridge: DesktopWindowBridge = {
    platform: "darwin",
    getRpcEndpoint: async () => ({ url: "ws://127.0.0.1:47831/rpc", token: "t" }),
    captureAnnotation: async () => { throw new Error("not in this test") },
    notify: async () => true,
    onNotificationActivate: (next) => {
      listener = next
      return () => { listener = undefined }
    },
    openDirectory: async () => ({ status: "cancelled" as const }),
    readClipboardText: async () => "",
    writeClipboardText: async () => true,
    openExternal: async () => true,
    onDeepLink: () => () => {},
    getWindowDecoration: async () => "domovoi",
    setWindowDecoration: async () => true,
    minimize: () => {},
    maximize: () => {},
    close: () => {},
  }
  return {
    windowBridge,
    activate: (sessionId: string) => {
      if (!listener) throw new Error("The shell has not subscribed to notification clicks")
      listener(sessionId)
    },
  }
}

describe("a session read that ends without an answer", () => {
  it("draws the failed-read state for the asked-for session when the connection closes mid-read", async () => {
    const { user, socket, other } = await openShell()
    await pickSession(user, other.title)
    expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: other.id })

    await act(async () => { socket.drop() })
    await settle()

    const state = failedRead()
    expect(state.textContent).toContain("The connection to the daemon closed before it answered.")
    expect(state.textContent).toContain("1 attempt")
    expect(within(state).getByText(new RegExp(`read ${other.title.slice(0, 24)}`))).toBeTruthy()
    expect(state.textContent).toContain("the connection closed before an answer")
    // The previous session's thread is not left under the new session's name.
    expect(screen.queryByText(previousLine)).toBeNull()
    // The alert says it too, as it does every failed open.
    expect(screen.getByText("Daemon connection closed")).toBeTruthy()
    // Activation writes the daemon's active session, so the state does not
    // claim nothing was written.
    expect(screen.queryByText("nothing was written, nothing was lost")).toBeNull()
    // What stays true is what a failed read cannot do, not a guess at the
    // session's state now: another client or the daemon may have moved it on.
    expect(state.textContent).toContain("A failed read does not change or remove the session. Opening one changes only which session the daemon has open.")
    expect(state.textContent).toContain("A failed read does not stop a turn. The daemon does not need this window.")
    expect(state.textContent).not.toMatch(/still on the machine|it is still running/u)
  })

  // With the connection down a Try again would never leave this client, so
  // it waits for the reconnect, and the failure stays on screen meanwhile.
  it("holds Try again until the connection is back, keeping the failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { user, socket, snapshot, other } = await openShell({}, { advanceTimers: vi.advanceTimersByTime })
    await pickSession(user, other.title)
    await act(async () => { socket.drop() })
    await settle()

    const retry = () => within(failedRead()).getByRole("button", { name: "Try again" }) as HTMLButtonElement
    expect(retry().disabled).toBe(true)
    expect(screen.getByText("Daemon connection closed")).toBeTruthy()

    for (let step = 0; step < 60 && harness.sockets.length < 2; step += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    }
    await act(async () => { completeHandshake(harness.socket(1), snapshot) })
    await settle()

    expect(retry().disabled).toBe(false)
    expect(failedRead().textContent).toContain("1 attempt")
    expect(screen.queryByText(previousLine)).toBeNull()
  })

  // The client knows only that no answer arrived in time, not why.
  it("says no answer arrived when the read runs out of time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { user, other } = await openShell({}, { advanceTimers: vi.advanceTimersByTime })
    await pickSession(user, other.title)

    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    await settle()

    const state = failedRead()
    expect(state.textContent).toContain("The daemon accepted the connection, but no answer to this read arrived within 120 seconds.")
    expect(state.textContent).not.toMatch(/stopped answering/u)
    expect(state.textContent).toContain("no answer in 120s")
    expect(state.textContent).toContain("1 attempt")
    expect(screen.queryByText(previousLine)).toBeNull()
    expect(screen.getByText("Daemon RPC request session.activate timed out after 120000ms")).toBeTruthy()
  })

  it("counts each Try again it sends and opens the session once the daemon answers", async () => {
    const { user, socket, other } = await openShell()
    await pickSession(user, other.title)
    await act(async () => { answerUnreadably(socket) })
    await settle()
    expect(failedRead().textContent).toContain("The daemon answered, but the answer could not be read.")
    expect(failedRead().textContent).toContain("1 attempt")
    expect(screen.getByText("Daemon returned an invalid RPC result")).toBeTruthy()

    // Try again clears the alert; the same failure again says so again.
    await user.click(within(failedRead()).getByRole("button", { name: "Try again" }))
    expect(screen.queryByText("Daemon returned an invalid RPC result")).toBeNull()
    expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: other.id })
    await act(async () => { answerUnreadably(socket) })
    await settle()
    expect(failedRead().textContent).toContain("2 attempts")
    expect(screen.getByText("Daemon returned an invalid RPC result")).toBeTruthy()

    await user.click(within(failedRead()).getByRole("button", { name: "Try again" }))
    await act(async () => {
      respond(socket, "session.activate", workspaceSnapshot({
        activeSessionId: other.id,
        thread: [{ id: "other-line", sessionId: other.id, kind: "system", body: "The second session's own line", createdAt: "2026-10-14T09:01:00.000Z" }],
      }))
    })
    await settle()
    expect(screen.queryByRole("region", { name: "Could not read this session" })).toBeNull()
    expect(screen.getByText("The second session's own line")).toBeTruthy()
    expect(screen.queryByText("Daemon returned an invalid RPC result")).toBeNull()
  })

  // The read can land on the daemon after the client stopped waiting: the
  // daemon then broadcasts the workspace with that session active.
  it("clears when the daemon reports the asked-for session active", async () => {
    const { user, socket, other } = await openShell()
    await pickSession(user, other.title)
    await act(async () => { answerUnreadably(socket) })
    await settle()
    expect(failedRead()).toBeTruthy()

    await act(async () => {
      notify(socket, "workspace.changed", workspaceSnapshot({
        activeSessionId: other.id,
        thread: [{ id: "other-line", sessionId: other.id, kind: "system", body: "The second session's own line", createdAt: "2026-10-14T09:01:00.000Z" }],
      }))
    })
    await settle()
    expect(screen.queryByRole("region", { name: "Could not read this session" })).toBeNull()
    expect(screen.getByText("The second session's own line")).toBeTruthy()
  })

  it("draws an answer whose envelope does not parse as a failed read", async () => {
    const { user, socket, other } = await openShell()
    await pickSession(user, other.title)
    await act(async () => { answerWithoutEnvelope(socket) })
    await settle()

    expect(failedRead().textContent).toContain("The daemon answered, but the answer could not be read.")
    expect(screen.queryByText(previousLine)).toBeNull()
    expect(screen.getByText("Daemon returned a response this client could not parse")).toBeTruthy()
  })

  // Only the latest open decides what the thread column shows: a read the
  // person has moved on from cannot put its failure over the session they
  // opened after it, whichever of the two ends first.
  it.each(["the later open answers first", "the earlier read fails first"] as const)("ignores a superseded read's failure when %s", async (order) => {
    const { user, socket, snapshot, other } = await openShell()
    const third = snapshot.sessions.find((session) => session.id !== snapshot.activeSessionId && session.id !== other.id)!
    await pickSession(user, other.title)
    await pickSession(user, third.title)
    const [earlier, later] = sentRequests(socket, "session.activate")
    expect(earlier?.params).toMatchObject({ sessionId: other.id })
    expect(later?.params).toMatchObject({ sessionId: third.id })

    const answerLater = () => {
      socket.answered.add(later!.id)
      socket.receive({ jsonrpc: "2.0", id: later!.id, result: workspaceSnapshot({
        activeSessionId: third.id,
        thread: [{ id: "third-line", sessionId: third.id, kind: "system", body: "The third session's own line", createdAt: "2026-10-14T09:02:00.000Z" }],
      }) })
    }
    const failEarlier = () => {
      socket.answered.add(earlier!.id)
      socket.receive({ jsonrpc: "2.0", id: earlier!.id, result: { unreadable: true } })
    }
    await act(async () => {
      if (order === "the later open answers first") { answerLater(); failEarlier() } else { failEarlier(); answerLater() }
    })
    await settle()

    expect(screen.queryByRole("region", { name: "Could not read this session" })).toBeNull()
    expect(screen.getByText("The third session's own line")).toBeTruthy()
    // The superseded read still failed, and the alert says so.
    expect(screen.getByText("Daemon returned an invalid RPC result")).toBeTruthy()
  })

  // A notification can open a session while Machines is on screen. The thread
  // column is not drawn there, so the alert still says the read failed.
  it("keeps the alert when the thread column is not on screen", async () => {
    const notifications = notifyingBridge()
    const { user, socket, other } = await openShell({ windowBridge: notifications.windowBridge })
    await pickSession(user, other.title)
    await act(async () => { answerUnreadably(socket) })
    await settle()
    await user.click(within(failedRead()).getByRole("button", { name: "Open the machine" }))
    await screen.findByRole("heading", { name: "Machines" })

    await act(async () => { notifications.activate(other.id) })
    await act(async () => { answerUnreadably(socket) })
    await settle()

    expect(screen.getByText("Daemon returned an invalid RPC result")).toBeTruthy()
  })

  // A notification can re-open the session already open. The thread column
  // keeps that session's thread, so the alert says its read failed.
  it("keeps the alert when the session that failed is the one already open", async () => {
    const notifications = notifyingBridge()
    const { socket, active } = await openShell({ windowBridge: notifications.windowBridge })

    await act(async () => { notifications.activate(active.id) })
    await act(async () => { answerUnreadably(socket) })
    await settle()

    expect(screen.queryByRole("region", { name: "Could not read this session" })).toBeNull()
    expect(screen.getByText("Daemon returned an invalid RPC result")).toBeTruthy()
    expect(screen.getByText(previousLine)).toBeTruthy()
  })

  // A notification can name a session this snapshot does not list, such as
  // one from a project the window has since left. The thread column draws a
  // failed read only for a listed session, so the alert says this one.
  it("keeps the alert for a session the snapshot does not list", async () => {
    const notifications = notifyingBridge()
    const { socket } = await openShell({ windowBridge: notifications.windowBridge })

    await act(async () => { notifications.activate("session-from-another-project") })
    expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: "session-from-another-project" })
    await act(async () => { answerUnreadably(socket) })
    await settle()

    expect(screen.queryByRole("region", { name: "Could not read this session" })).toBeNull()
    expect(screen.getByText("Daemon returned an invalid RPC result")).toBeTruthy()
    expect(screen.getByText(previousLine)).toBeTruthy()
  })

  it("opens the Machines view from Open the machine", async () => {
    const { user, socket, other } = await openShell()
    await pickSession(user, other.title)
    await act(async () => { answerUnreadably(socket) })
    await settle()

    expect(screen.getByText("Daemon returned an invalid RPC result")).toBeTruthy()

    expect(screen.queryByRole("heading", { name: "Machines" })).toBeNull()
    await user.click(within(failedRead()).getByRole("button", { name: "Open the machine" }))
    await screen.findByRole("heading", { name: "Machines" })
  })

  // session.activate is on phoneAndTabletRpcMethods and the Machines view is
  // drawn there, so neither is locked the way the provider's Try again is.
  it.each(["phone", "tablet"] as const)("leaves Try again and Open the machine working in a %s tab", async (clientKind) => {
    const { user, socket, other } = await openShell({ clientKind })
    await pickSession(user, other.title)
    await act(async () => { answerUnreadably(socket) })
    await settle()

    const retry = within(failedRead()).getByRole("button", { name: "Try again" }) as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    expect(failedRead().textContent).not.toMatch(/off in a phone or tablet tab/u)
    await user.click(retry)
    expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: other.id })
    await act(async () => { answerUnreadably(socket) })
    await settle()
    expect(failedRead().textContent).toContain("2 attempts")
    expect(screen.getByText("Daemon returned an invalid RPC result")).toBeTruthy()

    expect(screen.queryByRole("heading", { name: "Machines" })).toBeNull()
    await user.click(within(failedRead()).getByRole("button", { name: "Open the machine" }))
    await screen.findByRole("heading", { name: "Machines" })
  })
})

describe("a session read the daemon refuses", () => {
  it("stays in the alert and keeps the open session's thread", async () => {
    const { user, socket, other } = await openShell()
    await pickSession(user, other.title)
    await act(async () => { fail(socket, "session.activate", { code: -32602, message: "Session does not exist" }) })
    await settle()

    expect(screen.queryByRole("region", { name: "Could not read this session" })).toBeNull()
    expect(screen.getByText("Session does not exist")).toBeTruthy()
    expect(screen.getByText(previousLine)).toBeTruthy()
  })
})
