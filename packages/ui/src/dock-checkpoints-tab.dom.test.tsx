import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { checkpointsIntro } from "./checkpoints-panel"
import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  installFakeWebSocket,
  sentRequests,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const openSheet = async () => {
  // v2 starts with the sheet closed, so a test that reads the dock opens it
  // first. Already open is not an error: pinned runs render the same tabs.
  if (screen.queryAllByRole("tab", { name: "Changes" }).length > 0) return
  const open = screen.queryByRole("button", { name: "Open the sheet" })
  if (!open) return
  await userEvent.setup().click(open)
  await settle()
}

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

// The v2 sheet lists Plan, Preview, Changes, Terminal, History, Checkpoints,
// Rules. What this pins is the v2 order of the
// tabs that exist and that Checkpoints is a tab of its own, not History narrowed.
describe("the dock's Checkpoints tab", () => {
  it("sits in v2's order and loads only the checkpoints category when opened", async () => {
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => { completeHandshake(socket, workspaceSnapshot()) })
    await settle()
    await openSheet()
    const tabs = screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    expect(tabs.slice(0, 6)).toEqual(["Plan preview", "Preview", "Changes", "Terminal", "History", "Checkpoints"])
    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Checkpoints" }))
    await settle()
    const requests = sentRequests(socket, "session.history")
    expect(requests.at(-1)?.params).toMatchObject({ categories: ["checkpoints"] })
    expect(screen.getByText(checkpointsIntro)).toBeTruthy()
  })

  it("takes a labelled checkpoint for the active session through checkpoint.create", async () => {
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    const snapshot = workspaceSnapshot()
    await act(async () => { completeHandshake(socket, snapshot) })
    await settle()
    await openSheet()
    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Checkpoints" }))
    await settle()
    await user.click(screen.getByRole("button", { name: "Take a checkpoint" }))
    await user.type(screen.getByRole("textbox", { name: "Checkpoint label" }), "Before the rename")
    await user.click(screen.getByRole("button", { name: "Take checkpoint" }))
    await settle()
    expect(sentRequests(socket, "checkpoint.create").at(-1)?.params).toMatchObject({ sessionId: snapshot.activeSessionId, label: "Before the rename" })
  })
})
