import { demoWorkspace, type SessionEvidence } from "@getdomovoi/protocol"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform"
import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  installFakeWebSocket,
  respond,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })

const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

const worktree = "/Users/dana/src/acme-api/.domovoi/session-billing"

function bridge(openExternal: DesktopWindowBridge["openExternal"]): DesktopWindowBridge {
  return {
    platform: "darwin",
    getRpcEndpoint: async () => ({ url: "ws://127.0.0.1:47831/rpc", token: "t" }),
    captureAnnotation: async () => { throw new Error("not in this test") },
    notify: async () => true,
    onNotificationActivate: () => () => {},
    openDirectory: async () => ({ status: "cancelled" as const }),
    readClipboardText: async () => "",
    writeClipboardText: async () => true,
    openExternal,
    onDeepLink: () => () => {},
    getWindowDecoration: async () => "system",
    setWindowDecoration: async () => true,
    minimize: () => {},
    maximize: () => {},
    close: () => {},
  }
}

const evidence: SessionEvidence = {
  sessionId: "session-billing",
  refreshedAt: "2026-09-23T12:00:00.000Z",
  workspace: {
    baseCommit: "a".repeat(40),
    diff: "",
    diffTruncated: false,
    totalChangedFiles: 1,
    files: [{ path: "src/app.ts", status: "modified", staged: false, unstaged: true, additions: 1, deletions: 1, binary: false }],
    filesTruncated: false,
  },
  tests: { passed: 0, failed: 0, totalRuns: 0, runs: [], runsTruncated: false },
}

it("opens the active worktree in the chosen editor from the Changes tab", async () => {
  const openExternal = vi.fn(async () => true)
  render(<WorkspaceShell windowBridge={bridge(openExternal)} />)
  const socket = harness.socket(0)
  const snapshot = workspaceSnapshot({
    sessions: demoWorkspace.sessions.map((session) => session.id === "session-billing" ? { ...session, workspacePath: worktree } : session),
  })
  await act(async () => { completeHandshake(socket, snapshot) })
  await settle()
  const user = userEvent.setup()
  const open = screen.queryByRole("button", { name: "Open the sheet" })
  if (open) await user.click(open)
  await settle()
  await user.click(screen.getByRole("tab", { name: "Changes" }))
  await settle()
  await act(async () => { respond(socket, "session.evidence", evidence) })
  await settle()
  await user.click(screen.getByRole("button", { name: "Open in editor" }))
  expect(openExternal).toHaveBeenCalledWith(expect.objectContaining({ path: worktree }))
})
