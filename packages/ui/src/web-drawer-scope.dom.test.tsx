import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, installFakeWebSocket, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

// Web v2 (2026-09-23): a browser tab's sessions column names the one machine
// it reaches and that its credential ends with the tab.
it("tells a browser tab its scope and that the credential ends with the tab", async () => {
  render(<WorkspaceShell clientKind="web" />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, workspaceSnapshot()) })
  await settle()
  await userEvent.setup().click(screen.getByRole("button", { name: /^Sessions / }))
  const column = screen.getByRole("complementary", { name: "Sessions" })
  expect(column.textContent).toContain("this machine only")
  expect(column.textContent).toContain("Paired for this tab")
  expect(column.textContent).toContain("ends when it closes")
})
