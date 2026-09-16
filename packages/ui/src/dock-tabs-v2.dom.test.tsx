import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

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

// v2's sheet is Plan, Preview, Changes, Terminal, History, Checkpoints, Rules.
// There is no Session tab, and Comments is not a tab: the design draws the
// comments on a variant under the preview frame. Rules waits on its own slice.
describe("the dock's tab list", () => {
  it("is v2's list with no Session tab and no Comments tab", async () => {
    render(<WorkspaceShell />)
    await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
    await settle()
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Plan", "Preview", "Changes", "Terminal", "History", "Checkpoints",
    ])
  })

  it("draws the comments under the preview, counted, with the open ones first in line", async () => {
    render(<WorkspaceShell />)
    await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
    await settle()
    await userEvent.setup().click(screen.getByRole("tab", { name: "Preview" }))
    await settle()
    const comments = screen.getByRole("region", { name: "Comments on this preview" })
    expect(within(comments).getByText("COMMENTS")).toBeTruthy()
    expect(within(comments).getByText(/\d+ open/)).toBeTruthy()
    expect(within(comments).getByText("Run this migration on the WSL staging machine first.")).toBeTruthy()
  })
})
