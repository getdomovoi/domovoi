// Task 83: the variant chosen with Build on this rides every send of the
// session (Q342 A), so the composer shows it as a chip whether or not the dock
// is open, and Unpick on the chip stops it riding. What the chip shows and
// what the send carries come from one rule: a preview of this session.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"
import { workspaceSnapshotSchema, type Artifact, type WorkspaceSnapshot } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake, installFakeWebSocket, respond, sentRequests, workspaceSnapshot,
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

function variantOf(sessionId: string, id: string, order: number): Artifact {
  return {
    id: `variant-${id}`,
    sessionId,
    title: `Replay ${id.toUpperCase()}`,
    type: "preview",
    revision: 1,
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
    variantOf(sessionId, "a", 0),
    variantOf(sessionId, "b", 1),
  ]
  value.sessions.forEach((session) => { delete session.activeTurnId; session.state = "idle" })
  return workspaceSnapshotSchema.parse(value)
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

async function chooseVariantB() {
  const user = userEvent.setup()
  const opener = screen.queryByRole("button", { name: "Open the sheet" })
  if (opener && screen.queryAllByRole("tab", { name: "Preview" }).length === 0) await user.click(opener)
  await settle()
  await user.click(screen.getByRole("tab", { name: "Preview" }))
  await settle()
  await user.click(screen.getByRole("button", { name: "Build on this" }))
  await settle()
}

const composerChips = () => {
  const composer = document.querySelector<HTMLElement>("[data-workspace-composer]")
  if (!composer) throw new Error("The composer is missing")
  return within(composer).queryByRole("region", { name: "Attachments" })
}

function lastReview(socket: FakeWebSocket) {
  return (sentRequests(socket, "session.send").at(-1)?.params as { review: Record<string, unknown> }).review
}

it("shows the chosen variant in the composer, and Unpick there stops it riding the send", async () => {
  const socket = await open(idleWithVariants())
  expect(composerChips()).toBeNull()

  await chooseVariantB()

  const chip = within(composerChips()!).getByText("Variant B").closest("li")!
  expect(within(chip).getByText("HTML")).toBeTruthy()
  expect(within(chip).getByText("replay · the agent builds on this one")).toBeTruthy()

  await userEvent.setup().click(within(chip).getByRole("button", { name: "Unpick Variant B" }))
  await settle()

  expect(composerChips()).toBeNull()
  expect(screen.getByText("none chosen, both stay alive")).toBeTruthy()
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "After unpicking" } })
  fireEvent.click(screen.getByRole("button", { name: "Send message" }))
  expect(lastReview(socket)).not.toHaveProperty("buildBasis")
})

it("draws no chip for a remembered basis the send would not carry", async () => {
  const value = idleWithVariants()
  const sessionId = value.activeSessionId!
  localStorage.setItem(workspaceUiStorageKey, JSON.stringify({
    version: 6,
    dockCollapsed: true,
    surface: "workspace",
    projectId: value.project?.id ?? null,
    sessionId,
    layouts: {},
    previewBuildBasis: { [sessionId]: "variant-gone" },
  }))
  await open(value)

  expect(composerChips()).toBeNull()
})
