import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import type { WorkspacePlatform } from "./workspace-platform"
import { completeHandshake, installFakeWebSocket, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

// Settings, Skills, Machines and the Audit log load when first opened. A load
// that fails must stay inside that surface with a way to try again, and
// opening one must leave focus somewhere a keyboard can continue from.

const load = vi.hoisted(() => ({ auditFailures: 0, skillFailures: 0 }))

vi.mock("./audit-log-view", async (importOriginal) => {
  if (load.auditFailures > 0) {
    load.auditFailures -= 1
    throw new Error("Failed to fetch dynamically imported module")
  }
  return importOriginal()
})

vi.mock("./skill-browser", async (importOriginal) => {
  if (load.skillFailures > 0) {
    load.skillFailures -= 1
    throw new Error("Failed to fetch dynamically imported module")
  }
  return importOriginal()
})

let harness: FakeWebSocketHarness

beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
  load.auditFailures = 0
  load.skillFailures = 0
  // No idle time here: each surface loads when a click opens it. A module
  // loads once per file, so an idle prefetch would decide the later tests.
  vi.stubGlobal("requestIdleCallback", () => 0)
  vi.stubGlobal("cancelIdleCallback", () => {})
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

async function openWorkspace(platform?: WorkspacePlatform) {
  render(<WorkspaceShell {...(platform ? { platform } : {})} />)
  await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
  await settle()
}

it("moves focus to the heading of the surface it opens", async () => {
  await openWorkspace()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Settings" }))

  const heading = await screen.findByRole("heading", { level: 1, name: "Settings" })
  await settle()
  expect(document.activeElement).toBe(heading)
})

it("keeps a surface that failed to load inside the workspace, and loads it on Try again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  load.auditFailures = 1
  await openWorkspace()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /Audit log/ }))

  expect(await screen.findByText("Audit log did not load in this window. Nothing on the machine changed.")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Try again" }))
  expect(await screen.findByRole("heading", { level: 1, name: "Audit log" })).toBeTruthy()
})

// A web tab cannot fetch a failed chunk again, so the host's reload is what
// Try again does there, and only when the person asks.
it("reloads for new code on Try again when the host offers it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const reloadForNewCode = vi.fn()
  const platform: WorkspacePlatform = {
    dialogs: { pickProjectDirectory: vi.fn(async () => ({ status: "refused" as const, message: "no picker" })) },
    notifications: { delivery: () => ({ status: "ready" }), request: vi.fn(async () => ({ status: "ready" as const })), notify: vi.fn(async () => {}) },
    clipboard: { writeText: vi.fn(async () => {}) },
    install: { state: () => ({ status: "installed" }), prompt: vi.fn(async () => ({ status: "installed" as const })) },
    code: { reloadForNewCode },
  }
  load.skillFailures = 1
  await openWorkspace(platform)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await user.click(await screen.findByRole("button", { name: /^Skills/ }))

  expect(await screen.findByText("Skills did not load in this window. Nothing on the machine changed.")).toBeTruthy()
  expect(reloadForNewCode).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Try again" }))
  expect(reloadForNewCode).toHaveBeenCalledOnce()
})
