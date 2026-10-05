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
// suspends again.
const chunks = vi.hoisted(() => {
  const held = () => {
    let release = () => {}
    const ready = new Promise<void>((resolve) => { release = resolve })
    return { ready, release }
  }
  return { held, palette: held(), launcher: held() }
})

vi.mock("./command-palette", async (importOriginal) => {
  await chunks.palette.ready
  return importOriginal()
})

vi.mock("./launcher-dialog", async (importOriginal) => {
  await chunks.launcher.ready
  return importOriginal()
})

let harness: FakeWebSocketHarness

beforeEach(() => {
  try { localStorage.removeItem(workspaceUiStorageKey) } catch { /* a browser with site data blocked still runs the test */ }
  harness = installFakeWebSocket()
  chunks.palette = chunks.held()
  chunks.launcher = chunks.held()
  vi.resetModules()
  // No idle time here: nothing is fetched before a test opens it.
  vi.stubGlobal("requestIdleCallback", () => 0)
  vi.stubGlobal("cancelIdleCallback", () => {})
})

afterEach(() => {
  chunks.palette.release()
  chunks.launcher.release()
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

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
