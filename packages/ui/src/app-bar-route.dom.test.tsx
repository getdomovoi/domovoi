import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { demoWorkspace } from "@getdomovoi/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
const initialWidth = window.innerWidth

beforeEach(() => {
  try {
    localStorage.removeItem(workspaceUiStorageKey)
  } catch {
    // A browser without storage starts from the default layout anyway.
  }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: initialWidth })
})

async function openShell(clientKind: "desktop" | "web", rpcUrl?: string, snapshot = workspaceSnapshot()) {
  render(<WorkspaceShell clientKind={clientKind} {...(rpcUrl ? { rpcUrl } : {})} />)
  await act(async () => {
    completeHandshake(harness.socket(0), snapshot)
  })
}

const machineChip = () => screen.getByRole("button", { name: `Machines: ${demoWorkspace.machine.name}` })

// Web v2 appbar.route-chip and Desktop v2 titlebar.machine-chip: the chip
// names the route, loopback or the tailnet, not local or remote.
describe("the machine chip's route word", () => {
  it.each([
    ["web", "ws://127.0.0.1:47831/rpc", "loopback"],
    ["web", "wss://studio.example.ts.net:47831/rpc", "tailnet"],
    ["web", "wss://192.168.1.20:47831/rpc", "direct"],
    ["desktop", "ws://127.0.0.1:47831/rpc", "loopback"],
  ] as const)("a %s client at %s reads %s", async (clientKind, rpcUrl, word) => {
    await openShell(clientKind, rpcUrl)
    // The dot's label is in the button too, for a screen reader; the visible
    // words are the machine's name and then the route.
    expect(machineChip().textContent?.endsWith(`${demoWorkspace.machine.name}${word}`)).toBe(true)
  })
})

// Q362 A: the theme is a preference of this client that never reaches the
// daemon, so a watching client keeps it.
it("keeps the theme toggle live while watching", async () => {
  const user = userEvent.setup()
  await openShell("desktop", undefined, { ...workspaceSnapshot(), clientAccess: "watching" })
  const toggle = screen.getByRole("button", { name: /^Use (light|dark) theme$/ })
  const before = toggle.getAttribute("aria-label")
  expect(toggle.hasAttribute("disabled")).toBe(false)
  await user.click(toggle)
  expect(screen.getByRole("button", { name: /^Use (light|dark) theme$/ }).getAttribute("aria-label")).not.toBe(before)
})

// Q384 A: the web opens the sessions column by default at wide widths, as the
// Web v2 frame draws it. A narrow tab and the desktop keep it behind its button.
describe("the sessions column's first state", () => {
  const sessionsColumn = () => screen.queryByRole("complementary", { name: "Sessions" })

  it("is open in a wide browser tab", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 })
    await openShell("web")
    expect(sessionsColumn()).not.toBeNull()
  })

  it("is closed in a narrow browser tab", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 })
    await openShell("web")
    expect(sessionsColumn()).toBeNull()
  })

  it("is closed in the desktop at any width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 })
    await openShell("desktop")
    expect(sessionsColumn()).toBeNull()
  })
})
