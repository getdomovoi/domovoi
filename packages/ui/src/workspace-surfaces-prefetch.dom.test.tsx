import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import { completeHandshake, installFakeWebSocket, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

// The secondary surfaces are fetched at idle once the shell has painted. A
// fetch that fails there is not an error anyone sees: opening the surface
// loads it again. Its own file, because a module loads once per file.

const load = vi.hoisted(() => ({ auditFailures: 0 }))

vi.mock("./audit-log-view", async (importOriginal) => {
  if (load.auditFailures > 0) {
    load.auditFailures -= 1
    throw new Error("Failed to fetch dynamically imported module")
  }
  return importOriginal()
})

let harness: FakeWebSocketHarness

beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

async function openWorkspace() {
  render(<WorkspaceShell />)
  await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
  await settle()
}

it("fetches the surfaces at idle, and a failed fetch leaves opening the surface to load it", async () => {
  const idle: Array<() => void> = []
  vi.stubGlobal("requestIdleCallback", (run: IdleRequestCallback) => {
    idle.push(() => run({ didTimeout: false, timeRemaining: () => 50 }))
    return idle.length
  })
  vi.stubGlobal("cancelIdleCallback", () => {})
  load.auditFailures = 1
  await openWorkspace()
  expect(idle).toHaveLength(1)
  await act(async () => { idle[0]!() })
  await settle()
  expect(load.auditFailures).toBe(0)

  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Audit log/ }))
  expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy()
  expect(screen.queryByText(/did not load in this window/)).toBeNull()
})
