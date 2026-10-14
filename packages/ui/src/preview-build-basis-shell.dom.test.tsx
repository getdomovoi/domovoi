// Q342 A through the shell: the variant chosen with Build on this rides every
// send of that session (the thread's send, a queued send when it is released,
// and the plan's carry on), Unpick stops it, and a remembered id that no
// longer names a preview of the session is never sent.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  // No idle time here. The shell loads every lazy surface's code at idle
  // (prefetchWhenIdle). happy-dom has no requestIdleCallback, so that ran on a
  // 1 ms timer after the mount, and the first test also paid for loading
  // Settings, Skills, Machines and the rest while it ran. None of that code is
  // under test in this file.
  vi.stubGlobal("requestIdleCallback", () => 0)
  vi.stubGlobal("cancelIdleCallback", () => {})
})
afterEach(() => {
  cleanup()
  harness?.uninstall()
  vi.unstubAllGlobals()
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

it("sends no basis while none is chosen", async () => {
  const value = idleWithVariants()
  const socket = await open(value)

  type("Before choosing")
  expect(sentRequests(socket, "session.send")).toHaveLength(1)
  expect(lastReview(socket)).not.toHaveProperty("buildBasis")
})

// Each send path gets its own test, and mounting the shell and choosing
// variant B happen in beforeEach, outside the 5 s test budget. One test that
// walked every path after a mount took up to 3.8 s on Windows CI and timed out
// there once at 5185 ms.
describe("with variant B chosen through Build on this", () => {
  let value: WorkspaceSnapshot
  let sessionId: string
  let socket: FakeWebSocket

  beforeEach(async () => {
    value = idleWithVariants()
    sessionId = value.activeSessionId!
    socket = await open(value)
    await openSheetTab("Preview")
    await userEvent.setup().click(screen.getByRole("button", { name: "Build on this" }))
    await settle()
    expect(screen.getByText("the agent builds on this one")).toBeTruthy()
  })

  // One thread send, answered: exactly one more request, carrying the choice.
  async function sendFromThread(prompt: string) {
    const before = sentRequests(socket, "session.send").length
    type(prompt)
    expect(sentRequests(socket, "session.send")).toHaveLength(before + 1)
    expect(sentRequests(socket, "session.send").at(-1)?.params).toMatchObject({ sessionId, prompt })
    expect(lastReview(socket)).toEqual({ annotationIds: [], buildBasis: { artifactId: "variant-b" } })
    await answerLastSend(socket, value)
  }

  it("carries the chosen variant on every thread send", async () => {
    await sendFromThread("Build the replay table")
    await sendFromThread("And the header")
  })

  it("carries the chosen variant on a queued send when it is released", async () => {
    await sendFromThread("Build the replay table")
    // A message queued while the agent works is released when it stops, and
    // carries the choice too.
    await act(async () => notify(socket, "workspace.changed", running(value)))
    await settle()
    type("Then the empty state")
    expect(sentRequests(socket, "session.send")).toHaveLength(1)
    await act(async () => notify(socket, "workspace.changed", value))
    await settle()
    expect(sentRequests(socket, "session.send")).toHaveLength(2)
    expect(sentRequests(socket, "session.send").at(-1)?.params).toMatchObject({ sessionId, prompt: "Then the empty state" })
    expect(lastReview(socket)).toMatchObject({ buildBasis: { artifactId: "variant-b" } })
    // Its answer does not clear the choice.
    await answerLastSend(socket, value)
    await sendFromThread("After the queue")
  })

  it("carries the chosen variant on the plan's carry on", async () => {
    await sendFromThread("Build the replay table")
    await openSheetTab("Plan preview")
    await userEvent.setup().click(screen.getByRole("button", { name: "Looks right, carry on" }))
    expect(sentRequests(socket, "session.send")).toHaveLength(2)
    expect(sentRequests(socket, "session.send").at(-1)?.params).toMatchObject({ sessionId, prompt: "Looks right, carry on" })
    expect(lastReview(socket)).toMatchObject({ buildBasis: { artifactId: "variant-b" } })
    // Its answer does not clear the choice.
    await answerLastSend(socket, value)
    await sendFromThread("After carry on")
  })

  it("keeps the choice across sends until Unpick, then sends none", async () => {
    await sendFromThread("Build the replay table")
    await sendFromThread("And the header")

    await openSheetTab("Plan preview")
    await openSheetTab("Preview")
    await userEvent.setup().click(screen.getByRole("button", { name: "Unpick" }))
    await settle()
    type("After unpicking")
    expect(sentRequests(socket, "session.send").at(-1)?.params).toMatchObject({ sessionId, prompt: "After unpicking" })
    expect(lastReview(socket)).not.toHaveProperty("buildBasis")
  })
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
