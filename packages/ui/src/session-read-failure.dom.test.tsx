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
  workspaceSnapshot,
  type FakeWebSocket,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

// Opening a session is the one read the thread waits on: session.activate
// answers with the workspace whose thread is that session's. When it ends
// without an answer (no answer in time, the connection closed, an answer the
// client cannot read), the thread column draws the failed-read state for the
// session that was asked for, never the previous session's thread under it.
// A daemon that answers and refuses has answered: that stays in the alert.

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
  await user.click(screen.getByRole("button", { name: /^Sessions \d/ }))
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

const failedRead = () => screen.getByRole("region", { name: "Could not read this session" })

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
    // Said once, in the thread column, not again in the alert.
    expect(screen.queryByText("Daemon connection closed")).toBeNull()
    // Activation writes the daemon's active session, so the state does not
    // claim nothing was written.
    expect(screen.queryByText("nothing was written, nothing was lost")).toBeNull()
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

    for (let step = 0; step < 60 && harness.sockets.length < 2; step += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    }
    await act(async () => { completeHandshake(harness.socket(1), snapshot) })
    await settle()

    expect(retry().disabled).toBe(false)
    expect(failedRead().textContent).toContain("1 attempt")
    expect(screen.queryByText(previousLine)).toBeNull()
  })

  it("says the daemon stopped answering when the read runs out of time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { user, other } = await openShell({}, { advanceTimers: vi.advanceTimersByTime })
    await pickSession(user, other.title)

    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    await settle()

    const state = failedRead()
    expect(state.textContent).toContain("The daemon accepted the connection and then stopped answering mid-read.")
    expect(state.textContent).toContain("no answer in 120s")
    expect(state.textContent).toContain("1 attempt")
    expect(screen.queryByText(previousLine)).toBeNull()
    expect(screen.queryByText(/timed out after/u)).toBeNull()
  })

  it("counts each Try again it sends and opens the session once the daemon answers", async () => {
    const { user, socket, other } = await openShell()
    await pickSession(user, other.title)
    await act(async () => { answerUnreadably(socket) })
    await settle()
    expect(failedRead().textContent).toContain("The daemon answered, but the answer could not be read.")
    expect(failedRead().textContent).toContain("1 attempt")

    await user.click(within(failedRead()).getByRole("button", { name: "Try again" }))
    expect(pendingRequest(socket, "session.activate").params).toMatchObject({ sessionId: other.id })
    await act(async () => { answerUnreadably(socket) })
    await settle()
    expect(failedRead().textContent).toContain("2 attempts")

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

  it("opens the Machines view from Open the machine", async () => {
    const { user, socket, other } = await openShell()
    await pickSession(user, other.title)
    await act(async () => { answerUnreadably(socket) })
    await settle()

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
    expect(within(failedRead()).getByRole("button", { name: "Open the machine" })).toBeTruthy()
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
