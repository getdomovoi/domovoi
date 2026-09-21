import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
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
