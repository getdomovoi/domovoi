import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { systemEmergencyStoppedNotificationSchema, type ProviderRuntime, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  notify,
  respond,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

// Walk F14, ruling Q135: the design's launcher asks what the agent should
// work on and starts the session on it, so the goal typed in the launcher is
// the new session's first message, not only its name.

let harness: FakeWebSocketHarness

beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const codex: ProviderRuntime = { id: "codex", command: "codex", status: "ready", sessionCapable: true, version: "1.0.0" }

async function createFromLauncher(goal: string) {
  const base = workspaceSnapshot()
  const snapshot = workspaceSnapshot({ machine: { ...base.machine, providers: [codex] } })
  render(<WorkspaceShell />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "New session" }))
  await settle()
  await screen.findByText("Loading models")
  const models = [{
    provider: "codex",
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "",
    supportedReasoningEfforts: ["medium" as const],
    defaultReasoningEffort: "medium" as const,
    isDefault: true,
  }]
  await act(async () => {
    while (sentRequests(socket, "runtime.models").some((request) => !socket.answered.has(request.id))) respond(socket, "runtime.models", models)
  })
  await settle()
  await user.type(screen.getByLabelText("Session goal"), goal)
  await user.click(screen.getByRole("button", { name: "Create session" }))
  await settle()
  return { socket, snapshot }
}

// What session.create answers: the new session, idle, made active.
function created(snapshot: WorkspaceSnapshot, title: string): WorkspaceSnapshot {
  const next = structuredClone(snapshot)
  const template = next.sessions[0]!
  const session = { ...structuredClone(template), id: "session-new", title, state: "idle" as const }
  delete (session as { activeTurnId?: string }).activeTurnId
  next.sessions = [session, ...next.sessions]
  next.activeSessionId = session.id
  return next
}

it("sends the launcher's goal as the new session's first message once the session exists", async () => {
  const goal = "Rotate the staging keys"
  const { socket, snapshot } = await createFromLauncher(goal)

  // Nothing is sent before the session exists.
  expect(sentRequests(socket, "session.create")).toHaveLength(1)
  expect(sentRequests(socket, "session.send")).toEqual([])

  await act(async () => { respond(socket, "session.create", created(snapshot, goal)) })
  await settle()

  const sends = sentRequests(socket, "session.send")
  expect(sends).toHaveLength(1)
  expect(sends[0]?.params).toMatchObject({ sessionId: "session-new", prompt: goal })
})

// A stop holds the queues that exist when it lands. A goal added after it,
// by a create the stop overtook, must not start the work the stop ended.
it("holds the goal when a stop lands while the session is being created", async () => {
  const goal = "Rotate the staging keys"
  const { socket, snapshot } = await createFromLauncher(goal)

  await act(async () => {
    notify(socket, "system.emergencyStopped", systemEmergencyStoppedNotificationSchema.parse({
      snapshot, stopId: "stop-other-client", requestedAt: "2026-10-18T14:00:00Z", client: "phone",
      outcomes: { turnsStopped: 1, terminalsClosed: 0, approvalsDenied: 0, mutationsCancelled: 0, providersReset: 0 }, failures: [],
    }))
  })
  await settle()
  await act(async () => { respond(socket, "session.create", created(snapshot, goal)) })
  await settle()

  expect(sentRequests(socket, "session.send")).toEqual([])
  expect(screen.getByText(/Held because work was stopped/)).toBeTruthy()
})

it("sends nothing when the daemon does not create the session", async () => {
  const { socket } = await createFromLauncher("Rotate the staging keys")

  await act(async () => { fail(socket, "session.create", { code: -32602, message: "Open a valid Git repository with project.open before creating a session" }) })
  await settle()

  expect(sentRequests(socket, "session.send")).toEqual([])
  expect(await screen.findByText("Open a valid Git repository with project.open before creating a session")).toBeTruthy()
})
