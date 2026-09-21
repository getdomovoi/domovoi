import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

const openSheet = async () => {
  if (screen.queryAllByRole("tab", { name: "Changes" }).length > 0) return
  const open = screen.queryByRole("button", { name: "Open the sheet" })
  if (!open) return
  await userEvent.setup().click(open)
  await settle()
}

// A provider that writes its plan as prose gives us a plan document and no
// steps. The design's decision row belongs to the plan either way: a plan you
// cannot answer is a plan you cannot steer.
it("lets a prose plan be accepted", async () => {
  const snapshot = workspaceSnapshot()
  snapshot.workingPlans = []
  snapshot.artifacts = snapshot.artifacts.map((artifact) =>
    artifact.id === "artifact-plan" ? { ...artifact, content: "## Finish plan\n\nStep one." } : artifact,
  )
  render(<WorkspaceShell />)
  await act(async () => { completeHandshake(harness.socket(0), snapshot) })
  await settle()
  await openSheet()
  await userEvent.setup().click(screen.getByRole("tab", { name: "Plan preview" }))
  await settle()

  expect(screen.getByRole("button", { name: "Looks right, carry on" })).toBeTruthy()
})

const openProsePlan = async () => {
  const snapshot = workspaceSnapshot()
  snapshot.workingPlans = []
  snapshot.artifacts = snapshot.artifacts.map((artifact) =>
    artifact.id === "artifact-plan" ? { ...artifact, content: "## Finish plan\n\nStep one." } : artifact,
  )
  render(<WorkspaceShell />)
  await act(async () => { completeHandshake(harness.socket(0), snapshot) })
  await settle()
  await openSheet()
  await userEvent.setup().click(screen.getByRole("tab", { name: "Plan preview" }))
  await settle()
}

// A button that comes back from "Sending" with nothing said reads as a plan the
// agent accepted. The refusal has to reach the person who pressed it.
it("says so when the plan reply is refused", async () => {
  await openProsePlan()
  await userEvent.setup().click(screen.getByRole("button", { name: "Looks right, carry on" }))
  await settle()
  await act(async () => {
    fail(harness.socket(0), "session.send", { code: -32602, message: "The session is read only" })
  })
  await settle()

  expect(screen.getByText("The session is read only")).toBeTruthy()
})

// The prose branch renders a read-only quick view. Nothing in it carries a
// selection or opens the annotation flow, so copy that invites a line comment
// promises a control this branch does not have.
it("does not offer a comment the prose branch cannot take", async () => {
  await openProsePlan()

  expect(screen.queryByText(/select any line to comment/iu)).toBeNull()
})
