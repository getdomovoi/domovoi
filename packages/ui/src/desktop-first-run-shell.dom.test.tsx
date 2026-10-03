import { demoWorkspace, type ProviderRuntime } from "@getdomovoi/protocol"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform"
import { loadDesktopFirstRunState } from "./desktop-first-run-persistence"
import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, installFakeWebSocket, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket(); localStorage.clear() })
afterEach(() => { cleanup(); harness.uninstall() })
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

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

// Review P2-3: Codex is preferred, but only when it is ready. With Codex's
// status unknown and Claude Code ready, setup says an agent is ready and
// records Claude Code as the default.
it("records the ready agent as the default when the preferred one is not ready", async () => {
  const providers: ProviderRuntime[] = [
    { id: "codex", command: "codex", status: "unknown", sessionCapable: true },
    { id: "claude-code", command: "claude", status: "ready", version: "2.1.8", sessionCapable: true },
  ]
  render(<WorkspaceShell clientKind="desktop" windowBridge={bridge} localDaemon={{ title: "Running Domovoi inside this app", detail: "", owner: "app" }} />)
  // Idle sessions with no provider failure, so only the providers decide.
  const sessions = demoWorkspace.sessions.map((session) => {
    const { activeTurnId: _turn, providerFailure: _failure, ...rest } = session
    return { ...rest, state: "idle" as const }
  })
  await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot({ machine: { ...demoWorkspace.machine, providers }, sessions, approvals: [] })) })
  await settle()
  expect(await screen.findByText("New sessions start with Claude Code in Build manual. Add machines later from Machines.")).toBeTruthy()
  expect(screen.queryByText(/No agent is ready yet/u)).toBeNull()
  await userEvent.setup().click(screen.getByRole("button", { name: "One machine is enough for now" }))
  await settle()
  expect(loadDesktopFirstRunState(localStorage)).toMatchObject({ status: "complete", providerId: "claude-code", permissionMode: "build" })
})
