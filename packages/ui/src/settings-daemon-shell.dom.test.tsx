import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform"
import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, installFakeWebSocket, type FakeWebSocketHarness } from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

function bridge(platform: DesktopWindowBridge["platform"]): DesktopWindowBridge {
  return {
    platform,
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
}

// J24: the desktop's daemon copy names the owner but not the platform; the
// shell takes the platform from the window bridge, so Settings can name the
// service this machine's installer writes.
it("draws the daemon section with the window's platform", async () => {
  const localDaemon = { title: "Running Domovoi inside this app", detail: "This app started the local daemon and stops it when the app quits.", owner: "app" as const }
  render(<WorkspaceShell windowBridge={bridge("linux")} localDaemon={localDaemon} />)
  await act(async () => { completeHandshake(harness.socket(0)) })
  await settle()
  await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }))
  const section = await screen.findByRole("region", { name: "Daemon on this machine" })
  expect(section.textContent).toContain("~/.config/systemd/user/domovoid.service")
  expect(screen.queryByRole("region", { name: /local daemon/iu })).toBeNull()
})
