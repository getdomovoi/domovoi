import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform.js"
import { AppBar } from "./workspace-shell.js"

afterEach(cleanup)

function bridge(platform: DesktopWindowBridge["platform"]): DesktopWindowBridge {
  return {
    platform,
    titlebarLeadingInset: platform === "darwin" ? 84 : 0,
    getRpcEndpoint: vi.fn(async () => ({ url: "ws://127.0.0.1:47831/rpc", token: "token" })),
    captureAnnotation: vi.fn(),
    notify: vi.fn(async () => true),
    onNotificationActivate: vi.fn(() => () => {}),
    openDirectory: vi.fn(),
    readClipboardText: vi.fn(async () => ""),
    writeClipboardText: vi.fn(async () => true),
    openExternal: vi.fn(async () => true),
    onDeepLink: vi.fn(() => () => {}),
    getWindowDecoration: vi.fn(async () => "domovoi" as const),
    setWindowDecoration: vi.fn(async () => true),
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
  } as unknown as DesktopWindowBridge
}

function appBarProps() {
  return {
    snapshot: null,
    connected: true,
    emergencyStopPending: false,
    emergencyStopOutcome: null,
    emergencyStopError: null,
    onOpenProject: vi.fn(),
    onPauseAll: vi.fn(),
    onEmergencyStop: vi.fn(),
  }
}

it("draws Domovoi window controls while the window owns its decoration", () => {
  render(<AppBar {...appBarProps()} bridge={bridge("linux")} windowDecoration="domovoi" />)

  expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy()
})

it("leaves window controls to the operating system frame", () => {
  render(<AppBar {...appBarProps()} bridge={bridge("linux")} windowDecoration="system" />)

  expect(screen.queryByRole("button", { name: "Minimize" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
})

it("starts titlebar content past the macOS window buttons by the inset the desktop derived", () => {
  const domovoi = render(
    <AppBar {...appBarProps()} bridge={bridge("darwin")} windowDecoration="domovoi" />,
  )
  expect(domovoi.container.querySelector("header")?.style.paddingLeft).toBe("84px")
  cleanup()

  const system = render(
    <AppBar {...appBarProps()} bridge={bridge("darwin")} windowDecoration="system" />,
  )
  expect(system.container.querySelector("header")?.style.paddingLeft).toBe("")
  cleanup()

  const linux = render(
    <AppBar {...appBarProps()} bridge={bridge("linux")} windowDecoration="domovoi" />,
  )
  expect(linux.container.querySelector("header")?.style.paddingLeft).toBe("")
})
