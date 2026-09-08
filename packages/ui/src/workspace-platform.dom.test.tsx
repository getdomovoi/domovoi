import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { WorkspaceSnapshot } from "@getdomovoi/protocol"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import type { WorkspacePlatform } from "./workspace-platform"
import {
  completeHandshake,
  installFakeWebSocket,
  notify,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness

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
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

function browserPlatform(overrides: Partial<WorkspacePlatform> = {}): WorkspacePlatform {
  return {
    dialogs: {
      pickProjectDirectory: vi.fn().mockResolvedValue({
        status: "refused",
        message: "A browser cannot open a folder picker on the execution machine.",
      }),
    },
    notifications: {
      delivery: () => ({ status: "ready" }),
      request: vi.fn().mockResolvedValue({ status: "ready" }),
      notify: vi.fn().mockResolvedValue(undefined),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    install: {
      state: () => ({ status: "installed" }),
      prompt: vi.fn().mockResolvedValue({ status: "installed" }),
    },
    ...overrides,
  }
}

function withWorktree(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const updated = structuredClone(snapshot)
  updated.sessions = updated.sessions.map((session) =>
    session.id === updated.activeSessionId
      ? { ...session, workspacePath: "/Users/dev/src/acme-api/.domovoi/session-billing" }
      : session,
  )
  return updated
}

function finished(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const updated = structuredClone(snapshot)
  updated.sessions = updated.sessions.map((session) =>
    session.id === updated.activeSessionId
      ? { ...session, state: "done" as const, updatedAt: "2026-09-05T09:30:00.000Z" }
      : session,
  )
  return updated
}

async function openWorkspace(platform: WorkspacePlatform, snapshot = workspaceSnapshot()) {
  render(<WorkspaceShell platform={platform} />)
  const socket = harness.socket(0)
  await act(async () => {
    completeHandshake(socket, snapshot)
  })
  await settle()
  return socket
}

async function openCommandPalette() {
  await userEvent.click(screen.getByRole("button", { name: "Open command palette" }))
  await settle()
}

async function openNotificationSettings() {
  await userEvent.click(screen.getByRole("button", { name: "Settings" }))
  await settle()
  await userEvent.click(screen.getAllByRole("button", { name: "Notifications" })[0]!)
  await settle()
}

it("raises a workspace notification through the browser when there is no desktop bridge", async () => {
  const platform = browserPlatform()
  const snapshot = workspaceSnapshot()
  const socket = await openWorkspace(platform, snapshot)

  await act(async () => {
    notify(socket, "workspace.changed", finished(snapshot))
  })
  await settle()

  expect(platform.notifications.notify).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "completion", sessionId: snapshot.activeSessionId }),
  )
})

it("honours the notification preference before it reaches the browser", async () => {
  const platform = browserPlatform()
  const snapshot = workspaceSnapshot()
  const socket = await openWorkspace(platform, snapshot)

  await openNotificationSettings()
  await userEvent.click(screen.getByRole("switch", { name: "Completions" }))
  await settle()

  await act(async () => {
    notify(socket, "workspace.changed", finished(snapshot))
  })
  await settle()

  expect(platform.notifications.notify).not.toHaveBeenCalled()
})

it("copies the worktree path through the browser clipboard", async () => {
  const platform = browserPlatform()
  await openWorkspace(platform, withWorktree(workspaceSnapshot()))

  await openCommandPalette()
  await userEvent.click(screen.getByRole("option", { name: /Copy worktree path/ }))
  await settle()

  expect(platform.clipboard.writeText).toHaveBeenCalledWith("/Users/dev/src/acme-api/.domovoi/session-billing")
})

it("offers no external editor command where the browser cannot open one", async () => {
  await openWorkspace(browserPlatform(), withWorktree(workspaceSnapshot()))

  await openCommandPalette()

  expect(screen.getByRole("option", { name: /Copy worktree path/ })).toBeTruthy()
  expect(screen.queryByRole("option", { name: /Open externally/ })).toBeNull()
})

it("shows the clipboard refusal instead of leaving the command silent", async () => {
  const platform = browserPlatform({
    clipboard: {
      writeText: vi.fn().mockRejectedValue(new Error("The browser clipboard needs an HTTPS or localhost origin.")),
    },
  })
  await openWorkspace(platform, withWorktree(workspaceSnapshot()))

  await openCommandPalette()
  await userEvent.click(screen.getByRole("option", { name: /Copy worktree path/ }))
  await settle()

  expect(screen.getByText("The browser clipboard needs an HTTPS or localhost origin.")).toBeTruthy()
})

it("says why a browser has no folder picker when a project is opened", async () => {
  const platform = browserPlatform()
  await openWorkspace(platform, workspaceSnapshot())

  await openCommandPalette()
  await userEvent.click(screen.getByRole("option", { name: /Open project/ }))
  await settle()

  expect(platform.dialogs.pickProjectDirectory).toHaveBeenCalledOnce()
  expect(screen.getByRole("dialog").textContent).toContain(
    "A browser cannot open a folder picker on the execution machine.",
  )
})

it("carries the browser's own delivery state into the notification settings", async () => {
  const platform = browserPlatform({
    notifications: {
      delivery: () => ({ status: "refused", message: "This browser has blocked notifications for Domovoi." }),
      request: vi.fn(),
      notify: vi.fn(),
    },
  })
  await openWorkspace(platform, workspaceSnapshot())

  await openNotificationSettings()

  expect(screen.getByText("This browser has blocked notifications for Domovoi.")).toBeTruthy()
  expect(screen.getByRole("switch", { name: "Completions" }).getAttribute("disabled")).toBe("")
})
