// Q342 A through the shell: the variant chosen with Build on this rides every
// send of that session (the thread's send, a queued send when it is released,
// and the plan's carry on), Unpick stops it, and a remembered id that no
// longer names a preview of the session is never sent.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"
import { workspaceSnapshotSchema, type Artifact, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake, installFakeWebSocket, notify, respond, sentRequests, workspaceSnapshot,
  type FakeWebSocket, type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => {
  try { localStorage?.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})
afterEach(() => {
  cleanup()
  harness?.uninstall()
  try { localStorage?.removeItem(workspaceUiStorageKey) } catch { /* as above */ }
})

const settle = () => act(async () => { for (let index = 0; index < 8; index++) await Promise.resolve() })

function variantOf(sessionId: string, id: string, order: number, revision: number): Artifact {
  return {
    id: `variant-${id}`,
    sessionId,
    title: `Replay ${id.toUpperCase()}`,
    type: "preview",
    revision,
    mimeType: "text/html",
    path: `design-studio/replay/${id}.html`,
    variant: { groupId: "design-studio/replay", id, label: `Variant ${id.toUpperCase()}`, order },
  }
}

function idleWithVariants(): WorkspaceSnapshot {
  const value = workspaceSnapshot()
  const sessionId = value.activeSessionId!
  value.approvals = []
  value.annotations = []
  value.artifacts = [
    ...value.artifacts.filter((artifact) => artifact.type !== "preview"),
    variantOf(sessionId, "a", 0, 1),
    variantOf(sessionId, "b", 1, 2),
  ]
  value.sessions.forEach((session) => { delete session.activeTurnId; session.state = "idle" })
  return workspaceSnapshotSchema.parse(value)
}

function running(value: WorkspaceSnapshot): WorkspaceSnapshot {
  const next = structuredClone(value)
  next.sessions.forEach((session) => { session.activeTurnId = `turn-${session.id}`; session.state = "active" })
  return workspaceSnapshotSchema.parse(next)
}

async function open(value: WorkspaceSnapshot) {
  render(<WorkspaceShell />)
  const socket = harness.sockets.at(-1)!
  await act(async () => completeHandshake(socket, value))
  await act(async () => {
    respond(socket, "skill.list", [])
    const { id, name, platform, arch, version } = value.machine
    respond(socket, "skill.inventory", { machine: { id, name, platform, arch, version }, skills: [] })
  })
  await settle()
  return socket
}

async function openSheetTab(name: string) {
  const user = userEvent.setup()
  const opener = screen.queryByRole("button", { name: "Open the sheet" })
  if (opener && screen.queryAllByRole("tab", { name }).length === 0) await user.click(opener)
  await settle()
  await user.click(screen.getByRole("tab", { name }))
  await settle()
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } })
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
}

async function answerLastSend(socket: FakeWebSocket, value: WorkspaceSnapshot) {
  await act(async () => respond(socket, "session.send", value))
  await settle()
}

function lastReview(socket: FakeWebSocket) {
  return (sentRequests(socket, "session.send").at(-1)?.params as { review: Record<string, unknown> }).review
}

it("carries the chosen variant on the thread send, a released queued send and carry on, until Unpick", async () => {
  const value = idleWithVariants()
  const sessionId = value.activeSessionId!
  const socket = await open(value)

  // None chosen: nothing rides the send.
  type("Before choosing")
  expect(sentRequests(socket, "session.send")).toHaveLength(1)
  expect(lastReview(socket)).not.toHaveProperty("buildBasis")
  await answerLastSend(socket, value)

  await openSheetTab("Preview")
  await userEvent.setup().click(screen.getByRole("button", { name: "Build on this" }))
  await settle()
  expect(screen.getByText("the agent builds on this one")).toBeTruthy()

  type("Build the replay table")
  expect(sentRequests(socket, "session.send").at(-1)?.params).toMatchObject({ sessionId, prompt: "Build the replay table" })
  expect(lastReview(socket)).toEqual({ annotationIds: [], buildBasis: { artifactId: "variant-b" } })
  await answerLastSend(socket, value)

  // A message queued while the agent works is released when it stops, and
  // carries the choice too.
  await act(async () => notify(socket, "workspace.changed", running(value)))
  await settle()
  type("Then the empty state")
  expect(sentRequests(socket, "session.send")).toHaveLength(2)
  await act(async () => notify(socket, "workspace.changed", value))
  await settle()
  expect(sentRequests(socket, "session.send")).toHaveLength(3)
  expect(sentRequests(socket, "session.send").at(-1)?.params).toMatchObject({ prompt: "Then the empty state" })
  expect(lastReview(socket)).toMatchObject({ buildBasis: { artifactId: "variant-b" } })
  await answerLastSend(socket, value)

  await openSheetTab("Plan preview")
  await userEvent.setup().click(screen.getByRole("button", { name: "Looks right, carry on" }))
  expect(sentRequests(socket, "session.send").at(-1)?.params).toMatchObject({ prompt: "Looks right, carry on" })
  expect(lastReview(socket)).toMatchObject({ buildBasis: { artifactId: "variant-b" } })
  await answerLastSend(socket, value)

  await openSheetTab("Preview")
  await userEvent.setup().click(screen.getByRole("button", { name: "Unpick" }))
  await settle()
  type("After unpicking")
  expect(sentRequests(socket, "session.send").at(-1)?.params).toMatchObject({ prompt: "After unpicking" })
  expect(lastReview(socket)).not.toHaveProperty("buildBasis")
})

it("never sends a remembered basis that is gone or belongs to another session", async () => {
  const value = idleWithVariants()
  const sessionId = value.activeSessionId!
  const other = value.sessions.find((session) => session.id !== sessionId)!.id
  localStorage.setItem(workspaceUiStorageKey, JSON.stringify({
    version: 6,
    dockCollapsed: true,
    surface: "workspace",
    projectId: value.project?.id ?? null,
    sessionId,
    layouts: {},
    // variant-b is a preview of the active session, not of the other one.
    previewBuildBasis: { [sessionId]: "variant-gone", [other]: "variant-b" },
  }))
  const socket = await open(value)

  type("Gone")
  expect(lastReview(socket)).not.toHaveProperty("buildBasis")
  await answerLastSend(socket, value)

  await act(async () => notify(socket, "workspace.changed", workspaceSnapshotSchema.parse({ ...value, activeSessionId: other })))
  await settle()
  type("Elsewhere")
  expect(sentRequests(socket, "session.send").at(-1)?.params).toMatchObject({ sessionId: other, prompt: "Elsewhere" })
  expect(lastReview(socket)).not.toHaveProperty("buildBasis")
})
