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
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent)
    expect(tabs.slice(0, 6)).toEqual(["Plan", "Preview", "Changes", "Terminal", "History", "Checkpoints"])
    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Checkpoints" }))
    await settle()
    const requests = sentRequests(socket, "session.history")
    expect(requests.at(-1)?.params).toMatchObject({ categories: ["checkpoints"] })
    expect(screen.getByText(checkpointsIntro)).toBeTruthy()
  })
})
