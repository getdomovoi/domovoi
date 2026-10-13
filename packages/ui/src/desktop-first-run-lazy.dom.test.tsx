import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform"
import { loadDesktopFirstRunState } from "./desktop-first-run-persistence"
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
  ended: boolean
}

function held(): HeldChunk {
  let release = () => {}
  const ready = new Promise<void>((resolve) => { release = resolve })
  let request = () => {}
  const requested = new Promise<void>((resolve) => { request = resolve })
  return { ready, release, requested, request, requests: 0, ended: false }
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

async function openDesktop() {
  const { WorkspaceShell } = await import("./workspace-shell")
  render(<WorkspaceShell clientKind="desktop" windowBridge={bridge} />)
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
