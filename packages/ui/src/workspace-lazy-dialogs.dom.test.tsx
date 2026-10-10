import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { createEmptyWorkspace } from "@getdomovoi/protocol"

import type { WorkspacePlatform } from "./workspace-platform"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

// The command palette and the launcher load the first time one opens. Here
// their code arrives only when a test lets it, as a slow or stalled chunk
// would. Each test loads the shell afresh, since a loaded chunk never
// suspends again, and registers both mocks afresh: vi.resetModules keeps what
// a mock factory returned, so a mock registered once for the file would hold
// back only the first open, and each later test would race the cached code.
type HeldChunk = {
  ready: Promise<void>
  release: () => void
  // Settles once the shell has asked for the code, which can take a few
  // turns after the open: the import goes through the module runner first.
  requested: Promise<void>
  request: () => void
  ended: boolean
}

function held(): HeldChunk {
  let release = () => {}
  const ready = new Promise<void>((resolve) => { release = resolve })
  let request = () => {}
  const requested = new Promise<void>((resolve) => { request = resolve })
  return { ready, release, requested, request, ended: false }
}

const chunks = { palette: held(), launcher: held() }

function heldBack(chunk: HeldChunk) {
  return async (importOriginal: () => Promise<unknown>) => {
    chunk.request()
    await chunk.ready
    const actual = await importOriginal()
    // A load that lands after its test has ended never settles, so it cannot
    // fill in the mock the next test registers.
    return chunk.ended ? new Promise<never>(() => {}) : actual
  }
}

// Waits until the open has asked for the held code, so a check on the
// stand-in cannot pass or fail on how fast the import is dispatched.
const requested = (chunk: HeldChunk) => act(async () => { await chunk.requested })

let harness: FakeWebSocketHarness

beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
  chunks.palette = held()
  chunks.launcher = held()
  vi.resetModules()
  vi.doMock("./command-palette", heldBack(chunks.palette))
  vi.doMock("./launcher-dialog", heldBack(chunks.launcher))
  // No idle time here: nothing is fetched before a test opens it.
  vi.stubGlobal("requestIdleCallback", () => 0)
  vi.stubGlobal("cancelIdleCallback", () => {})
})

afterEach(async () => {
  chunks.palette.ended = true
  chunks.launcher.ended = true
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // A load that returned just before the test ended is recorded by the mock
  // a few promise turns later; let that finish before the next registration.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

// Lets a held chunk arrive and the shell draw what it brought.
const arrive = async (chunk: { release: () => void }) => {
  await act(async () => {
    chunk.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await settle()
}

async function openWorkspace({ platform, snapshot = workspaceSnapshot() }: {
  platform?: WorkspacePlatform
  snapshot?: ReturnType<typeof workspaceSnapshot>
} = {}) {
  const { WorkspaceShell } = await import("./workspace-shell")
  render(<WorkspaceShell {...(platform ? { platform } : {})} />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  return socket
}

// Opens the workspace and lets the idle prefetch fetch both dialogs' code
// before anything is opened, as it does once the shell has painted.
async function openPrefetchedWorkspace() {
  const idle: Array<() => void> = []
  vi.stubGlobal("requestIdleCallback", (run: IdleRequestCallback) => {
    idle.push(() => run({ didTimeout: false, timeRemaining: () => 50 }))
    return idle.length
  })
  chunks.palette.release()
  chunks.launcher.release()
  await openWorkspace()
  expect(idle.length).toBeGreaterThan(0)
  await act(async () => { for (const run of idle) run() })
  await act(async () => {
    await import("./command-palette")
    await import("./launcher-dialog")
  })
  await settle()
}

// Every stand-in drawn from here on, however briefly.
function watchForStandIns(): { seen: () => number, stop: () => void } {
  let seen = 0
  const count = () => { if (document.querySelector("[aria-busy=\"true\"]")) seen += 1 }
  const observer = new MutationObserver(count)
  observer.observe(document.body, { subtree: true, childList: true, attributes: true })
  return { seen: () => { count(); return seen }, stop: () => observer.disconnect() }
}

it("shows what a project switch stops before any dialog's code has loaded", async () => {
  const platform: WorkspacePlatform = {
    dialogs: { pickProjectDirectory: vi.fn(async () => ({ status: "selected" as const, path: "/code/elsewhere" })) },
    notifications: { delivery: () => ({ status: "ready" }), request: vi.fn(async () => ({ status: "ready" as const })), notify: vi.fn(async () => {}) },
    clipboard: { writeText: vi.fn(async () => {}) },
    install: { state: () => ({ status: "installed" }), prompt: vi.fn(async () => ({ status: "installed" as const })) },
  }
  const socket = await openWorkspace({ platform, snapshot: workspaceSnapshot(createEmptyWorkspace(workspaceSnapshot().machine)) })
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "New session" }))
  await settle()
  await act(async () => {
    fail(socket, "project.open", {
      code: -32010,
      message: "Switching projects stops running work",
      data: {
        kind: "project-switch-confirmation",
        requestedPath: "/code/elsewhere",
        sessions: [
          { id: "session-1", title: "First task", state: "active", workspacePath: "/worktrees/session-1" },
          { id: "session-2", title: "Second task", state: "archived" },
        ],
        sessionCount: 2,
        worktreeCount: 1,
      },
    })
  })
  await settle()

  const confirmation = screen.getByRole("alertdialog", { name: "Stop running work and switch projects?" })
  expect(confirmation.textContent).toContain("Domovoi keeps 2 sessions and their saved history, including 1 isolated worktree")
  expect(confirmation.textContent).toContain("stops any turn, provider thread, and terminal that is still running")
  expect(confirmation.textContent).toContain("First task")
  expect(confirmation.textContent).toContain("/worktrees/session-1")
  expect(confirmation.textContent).toContain("Second task")
  expect(screen.getByRole("button", { name: "Stop work and switch" })).toBeTruthy()
})

it("lets a launcher opened before its code arrives be closed, and keeps it closed", async () => {
  await openWorkspace()
  const user = userEvent.setup()
  const opener = screen.getByRole("button", { name: "New session" })
  await user.click(opener)
  await settle()

  await requested(chunks.launcher)
  const loading = screen.getByRole("dialog", { name: "Start a session" })
  expect(loading.getAttribute("aria-busy")).toBe("true")
  expect(loading.contains(document.activeElement)).toBe(true)
  expect(screen.queryByLabelText("Session goal")).toBeNull()

  await user.keyboard("{Escape}")
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(opener)

  await arrive(chunks.launcher)
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.queryByLabelText("Session goal")).toBeNull()
})

it("lets a palette opened before its code arrives be closed, and keeps it closed", async () => {
  await openWorkspace()
  const user = userEvent.setup()
  const opener = screen.getByRole("button", { name: "New session" })
  opener.focus()
  await user.keyboard("{Control>}k{/Control}")
  await settle()

  await requested(chunks.palette)
  const loading = screen.getByRole("dialog", { name: "Domovoi commands" })
  expect(loading.getAttribute("aria-busy")).toBe("true")
  expect(loading.contains(document.activeElement)).toBe(true)
  expect(screen.queryByRole("combobox")).toBeNull()

  await user.keyboard("{Escape}")
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(opener)

  await arrive(chunks.palette)
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.queryByRole("combobox")).toBeNull()
})

it("replaces the loading launcher with the launcher once its code arrives", async () => {
  await openWorkspace()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "New session" }))
  await settle()
  await requested(chunks.launcher)
  expect(screen.getByRole("dialog", { name: "Start a session" }).getAttribute("aria-busy")).toBe("true")

  await arrive(chunks.launcher)
  const goal = await screen.findByLabelText("Session goal")
  const launcher = screen.getByRole("dialog", { name: "Start a session" })
  expect(launcher.contains(goal)).toBe(true)
  expect(launcher.getAttribute("aria-busy")).toBeNull()
  expect(screen.getAllByRole("dialog")).toHaveLength(1)
  expect(launcher.contains(document.activeElement)).toBe(true)

  await user.keyboard("{Escape}")
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("replaces the loading palette with the palette once its code arrives", async () => {
  await openWorkspace()
  const user = userEvent.setup()
  const opener = screen.getByRole("button", { name: "New session" })
  opener.focus()
  await user.keyboard("{Control>}k{/Control}")
  await settle()
  await requested(chunks.palette)
  expect(screen.getByRole("dialog", { name: "Domovoi commands" }).getAttribute("aria-busy")).toBe("true")

  await arrive(chunks.palette)
  const search = await screen.findByRole("combobox")
  const palette = screen.getByRole("dialog", { name: "Domovoi commands" })
  expect(palette.contains(search)).toBe(true)
  expect(palette.getAttribute("aria-busy")).toBeNull()
  expect(screen.getAllByRole("dialog")).toHaveLength(1)
  expect(document.activeElement).toBe(search)

  // A focus move the replaced stand-in scheduled must not take focus back.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  expect(document.activeElement).toBe(screen.getByRole("combobox"))

  await user.keyboard("{Escape}")
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(opener)
})

it("opens a palette whose code the idle prefetch already fetched at once, with no stand-in", async () => {
  await openPrefetchedWorkspace()
  const user = userEvent.setup()
  const opener = screen.getByRole("button", { name: "New session" })
  opener.focus()
  const standIns = watchForStandIns()

  await user.keyboard("{Control>}k{/Control}")
  expect(document.querySelector("[aria-busy=\"true\"]")).toBeNull()
  const search = screen.getByRole("combobox")
  expect(screen.getByRole("dialog", { name: "Domovoi commands" }).contains(search)).toBe(true)
  await settle()
  expect(standIns.seen()).toBe(0)
  standIns.stop()

  await user.keyboard("{Escape}")
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(opener)
})

it("opens a launcher whose code the idle prefetch already fetched at once, with no stand-in", async () => {
  await openPrefetchedWorkspace()
  const user = userEvent.setup()
  const standIns = watchForStandIns()

  await user.click(screen.getByRole("button", { name: "New session" }))
  expect(document.querySelector("[aria-busy=\"true\"]")).toBeNull()
  const goal = screen.getByLabelText("Session goal")
  expect(screen.getByRole("dialog", { name: "Start a session" }).contains(goal)).toBe(true)
  await settle()
  expect(standIns.seen()).toBe(0)
  standIns.stop()

  await user.keyboard("{Escape}")
  await settle()
  expect(screen.queryByRole("dialog")).toBeNull()
})
