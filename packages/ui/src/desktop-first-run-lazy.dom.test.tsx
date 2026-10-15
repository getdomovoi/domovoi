import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform"
import { dismissDesktopFirstRun, loadDesktopFirstRunState, saveDesktopFirstRunState } from "./desktop-first-run-persistence"
import { completeHandshake, installFakeWebSocket, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

// First-run setup opens only in the desktop app, so its code is not part of
// what a launch loads: the web never asks for it, and the desktop loads it
// when setup opens. Here the code arrives only when a test lets it, as a slow
// chunk would. Each test loads the shell afresh, since a loaded chunk never
// suspends again (workspace-lazy-dialogs.dom.test.tsx has the same shape).
type HeldChunk = {
  ready: Promise<void>
  release: () => void
  // Settles once the shell has asked for the code, which can take a few
  // turns after the open: the import goes through the module runner first.
  requested: Promise<void>
  request: () => void
  requests: number
  // How many loads from now fail, as a chunk that cannot be fetched would.
  failures: number
  ended: boolean
}

function held(): HeldChunk {
  let release = () => {}
  const ready = new Promise<void>((resolve) => { release = resolve })
  let request = () => {}
  const requested = new Promise<void>((resolve) => { request = resolve })
  return { ready, release, requested, request, requests: 0, failures: 0, ended: false }
}

let chunk = held()
let harness: FakeWebSocketHarness

beforeEach(() => {
  localStorage.clear()
  harness = installFakeWebSocket()
  chunk = held()
  const current = chunk
  vi.resetModules()
  vi.doMock("./desktop-first-run", async (importOriginal: () => Promise<unknown>) => {
    current.requests += 1
    current.request()
    await current.ready
    if (current.failures > 0) {
      current.failures -= 1
      throw new Error("Failed to fetch dynamically imported module")
    }
    const actual = await importOriginal()
    return current.ended ? new Promise<never>(() => {}) : actual
  })
  // No idle time unless a test gives it: the shell's idle prefetch of the
  // other surfaces is not what these tests measure.
  vi.stubGlobal("requestIdleCallback", () => 0)
  vi.stubGlobal("cancelIdleCallback", () => {})
})

afterEach(async () => {
  chunk.ended = true
  cleanup()
  harness.uninstall()
  vi.doUnmock("./desktop-first-run")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const arrive = async () => {
  await act(async () => {
    chunk.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await settle()
}

const bridge: DesktopWindowBridge = {
  platform: "darwin",
  getRpcEndpoint: async () => ({ url: "ws://127.0.0.1:47831/rpc", token: "t" }),
  captureAnnotation: async () => { throw new Error("not in this test") },
  notify: async () => true,
  onNotificationActivate: () => () => {},
  openDirectory: async () => ({ status: "cancelled" as const }),
  readClipboardText: async () => "",
  writeClipboardText: async () => true,
  openExternal: async () => true,
  onDeepLink: () => () => {},
  getWindowDecoration: async () => "system",
  setWindowDecoration: async () => true,
  minimize: () => {},
  maximize: () => {},
  close: () => {},
}

async function openDesktop(windowBridge: DesktopWindowBridge = bridge) {
  const { WorkspaceShell } = await import("./workspace-shell")
  render(<WorkspaceShell clientKind="desktop" windowBridge={windowBridge} />)
  await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
  await settle()
}

it("never loads the setup code in the web client, at launch or at idle", async () => {
  const idle: Array<() => void> = []
  vi.stubGlobal("requestIdleCallback", (run: IdleRequestCallback) => {
    idle.push(() => run({ didTimeout: false, timeRemaining: () => 50 }))
    return idle.length
  })
  vi.stubGlobal("cancelIdleCallback", () => {})
  const { WorkspaceShell } = await import("./workspace-shell")
  render(<WorkspaceShell />)
  await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
  await settle()
  await act(async () => { for (const run of idle) run() })
  // The idle prefetch imports every other surface. They finish here, before
  // the next test resets the module registry under them.
  await act(async () => { await vi.dynamicImportSettled() })
  await settle()
  expect(chunk.requests).toBe(0)
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("shows a setup frame with focus in it while the code loads, then the setup in its place", async () => {
  await openDesktop()
  await act(async () => { await chunk.requested })
  expect(chunk.requests).toBe(1)
  const loading = screen.getByRole("dialog", { name: "Domovoi setup" })
  expect(loading.getAttribute("aria-busy")).toBe("true")
  expect(loading.contains(document.activeElement)).toBe(true)
  expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull()

  await arrive()
  const setup = await screen.findByRole("dialog", { name: /Connect an agent on/ })
  expect(setup.getAttribute("aria-busy")).toBeNull()
  expect(screen.getAllByRole("dialog")).toHaveLength(1)
  expect(setup.contains(document.activeElement)).toBe(true)

  await userEvent.setup().click(screen.getByRole("button", { name: "Skip for now" }))
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(loadDesktopFirstRunState(localStorage).status).toBe("dismissed")
})

it("skips setup when its frame is closed before the code arrives, and stays closed after", async () => {
  await openDesktop()
  await act(async () => { await chunk.requested })
  expect(screen.getByRole("dialog", { name: "Domovoi setup" }).getAttribute("aria-busy")).toBe("true")

  await userEvent.setup().keyboard("{Escape}")
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(loadDesktopFirstRunState(localStorage).status).toBe("dismissed")

  await arrive()
  expect(screen.queryByRole("dialog")).toBeNull()
})

// A setup whose code cannot be fetched says so in its own frame. It never
// takes the workspace down with it, open or closed.
it("says setup did not load when its code fails, and Try again loads it", async () => {
  chunk.failures = 1
  // The failed load is logged by design; the frame is what is checked here.
  vi.spyOn(console, "error").mockImplementation(() => {})
  await openDesktop()
  await act(async () => { await chunk.requested })
  await arrive()

  const failed = await screen.findByRole("dialog", { name: "Setup did not load in this window. Nothing on the machine changed." })
  expect(failed.getAttribute("aria-busy")).toBeNull()
  expect(failed.contains(document.activeElement)).toBe(true)
  expect(screen.getByRole("button", { name: "Settings", hidden: true })).toBeTruthy()

  await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
  await settle()
  const setup = await screen.findByRole("dialog", { name: /Connect an agent on/ })
  expect(chunk.requests).toBe(2)
  expect(screen.getAllByRole("dialog")).toHaveLength(1)
  expect(setup.contains(document.activeElement)).toBe(true)
})

it("skips setup from the frame that says it did not load", async () => {
  chunk.failures = 1
  // The failed load is logged by design; the frame is what is checked here.
  vi.spyOn(console, "error").mockImplementation(() => {})
  await openDesktop()
  await act(async () => { await chunk.requested })
  await arrive()

  await userEvent.setup().click(await screen.findByRole("button", { name: "Skip for now" }))
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(loadDesktopFirstRunState(localStorage).status).toBe("dismissed")
  expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy()
})

it("leaves the workspace as it was when setup was closed before its code failed to load", async () => {
  chunk.failures = 1
  // The failed load is logged by design; the frame is what is checked here.
  vi.spyOn(console, "error").mockImplementation(() => {})
  await openDesktop()
  await act(async () => { await chunk.requested })
  await userEvent.setup().keyboard("{Escape}")
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()

  await arrive()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy()
  expect(loadDesktopFirstRunState(localStorage).status).toBe("dismissed")
})

it.each([
  ["Skip for now", async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole("button", { name: "Skip for now" })) }],
  ["Escape", async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard("{Escape}") }],
])("gives focus back to Settings when setup that did not load is closed with %s", async (_label, close) => {
  saveDesktopFirstRunState(localStorage, dismissDesktopFirstRun())
  chunk.failures = 1
  // The failed load is logged by design; the frame is what is checked here.
  vi.spyOn(console, "error").mockImplementation(() => {})
  await openDesktop()
  expect(screen.queryByRole("dialog")).toBeNull()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Settings" }))
  const opener = await screen.findByRole("button", { name: "First-run setup" })
  await user.click(opener)
  await act(async () => { await chunk.requested })
  await arrive()
  await screen.findByRole("dialog", { name: "Setup did not load in this window. Nothing on the machine changed." })

  await close(user)
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "First-run setup" }))
})

// Setup covers the whole window, its header where the shell's titlebar was.
// With Domovoi's own decoration on macOS the window buttons sit over that row,
// so the header starts past them by the inset the desktop derived, as the
// titlebar does (window-decoration.dom.test.tsx). The row drags the window and
// every control in it opts out, as in the titlebar (app-bar-drag.dom.test.tsx).
const dragRowOf = (element: HTMLElement) => element.closest<HTMLElement>(".electron-drag")
const titlebarControls = (row: HTMLElement | null) => [...row?.querySelectorAll("button, a[href], input, select, textarea, [role='button']") ?? []]

it("starts the setup header and its loading frame past the macOS window buttons, and drags the window from them", async () => {
  await openDesktop({ ...bridge, titlebarLeadingInset: 84, getWindowDecoration: async () => "domovoi" })
  await act(async () => { await chunk.requested })
  expect(dragRowOf(screen.getByText("Domovoi setup"))?.style.paddingLeft).toBe("84px")

  await arrive()
  await screen.findByRole("dialog", { name: /Connect an agent on/ })
  const header = dragRowOf(screen.getByRole("button", { name: "Skip for now" }))
  expect(header?.style.paddingLeft).toBe("84px")
  expect(header?.textContent).toContain("Setup")
  expect(titlebarControls(header).length).toBeGreaterThan(0)
  for (const control of titlebarControls(header)) {
    expect(control.closest(".electron-no-drag"), `${control.textContent} inherits the drag region`).not.toBeNull()
  }
})

it.each([
  ["on Linux", { ...bridge, platform: "linux" as const, titlebarLeadingInset: 0, getWindowDecoration: async () => "domovoi" as const }],
  ["under the macOS system frame", { ...bridge, titlebarLeadingInset: 84, getWindowDecoration: async () => "system" as const }],
])("reserves no inset in the setup header %s", async (_label, windowBridge) => {
  await openDesktop(windowBridge)
  await act(async () => { await chunk.requested })
  expect(dragRowOf(screen.getByText("Domovoi setup"))?.style.paddingLeft).toBe("")

  await arrive()
  await screen.findByRole("dialog", { name: /Connect an agent on/ })
  expect(dragRowOf(screen.getByRole("button", { name: "Skip for now" }))?.style.paddingLeft).toBe("")
})
