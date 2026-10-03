import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform"
import { WorkspaceShell } from "./workspace-shell"
import { completeHandshake, installFakeWebSocket, pendingRequest, respond, workspaceSnapshot, type FakeWebSocketHarness } from "./test-support/fake-websocket"

// TailnetReach (Q404 A) in desktop Settings: the switch is a row of the
// daemon card, and the pairing card's two actions lead to it.

let harness: FakeWebSocketHarness
beforeEach(() => { harness = installFakeWebSocket() })
afterEach(() => { cleanup(); harness.uninstall() })
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() })

const off = { state: "off", name: "studio.tail4c2e.ts.net", address: "100.101.102.103", stored: "~/.domovoi/tls/studio.tail4c2e.ts.net.crt, .key", httpsCertificates: true }

function bridge(tailnetReach?: DesktopWindowBridge["tailnetReach"]): DesktopWindowBridge {
  return {
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
    ...(tailnetReach ? { tailnetReach } : {}),
  }
}

async function openSettings(windowBridge: DesktopWindowBridge) {
  render(<WorkspaceShell clientKind="desktop" windowBridge={windowBridge} localDaemon={{ title: "Running Domovoi inside this app", detail: "", owner: "app", inApp: true }} />)
  const socket = harness.socket(0)
  await act(async () => { completeHandshake(socket, workspaceSnapshot()) })
  await settle()
  const user = userEvent.setup()
  const skip = screen.queryByRole("button", { name: "Skip for now" })
  if (skip) { await user.click(skip); await settle() }
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await screen.findByRole("region", { name: "Daemon on this machine" })
  await settle()
  return { socket, user }
}

it("draws the switch as a row of the daemon card, with the daemon's own listener state", async () => {
  const tailnetReach = vi.fn(async () => off)
  const { socket } = await openSettings(bridge(tailnetReach))
  const daemon = screen.getByRole("region", { name: "Daemon on this machine" })
  const reach = within(daemon).getByRole("region", { name: "Reach this machine from my tailnet" })
  // Codex review round 1 (P3-6): until the daemon answers, where it listens
  // is not known, and the card does not say only this computer.
  expect(within(reach).getByText("Off. Whether the daemon answers anywhere but this computer is not known from here.")).toBeTruthy()
  expect(tailnetReach).toHaveBeenCalledWith("status")
  expect(pendingRequest(socket, "tailnet.status").params).toEqual({})
  await act(async () => { respond(socket, "tailnet.status", { state: "off" }) })
  expect(within(reach).getByText("Off. Only this computer can reach the daemon.")).toBeTruthy()
})

it("has no switch when the desktop offers none", async () => {
  await openSettings(bridge())
  expect(screen.queryByRole("region", { name: "Reach this machine from my tailnet" })).toBeNull()
})

it("leads a loopback pairing code to the tailnet setting", async () => {
  const { socket, user } = await openSettings(bridge(async () => off))
  await user.click(await screen.findByRole("button", { name: "Show a pairing code" }))
  await settle()
  await act(async () => {
    respond(socket, "device.issueCode", { code: "hearth-quiet-ember-42", expiresAt: new Date(Date.now() + 180_000).toISOString(), pairingAddress: { url: "ws://127.0.0.1:47831/rpc", loopback: true } })
  })
  await settle()
  expect(screen.getByText("No code: a phone cannot reach this machine yet")).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Go to the setting" }))
  await settle()
  expect(screen.getByRole("region", { name: "Reach this machine from my tailnet" }).className).toContain("bg-primary/10")
})
