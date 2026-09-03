import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import type { DesktopWindowBridge } from "./desktop-platform.js"
import { AppBar } from "./workspace-shell.js"

afterEach(cleanup)

function bridge(platform: DesktopWindowBridge["platform"]): DesktopWindowBridge {
  return {
    platform,
    getRpcToken: vi.fn(async () => "token"),
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

it("reserves no traffic-light inset under a system frame on macOS", () => {
  const domovoi = render(
    <AppBar {...appBarProps()} bridge={bridge("darwin")} windowDecoration="domovoi" />,
  )
  expect(domovoi.container.querySelectorAll("[aria-hidden=\"true\"].w-\\[64px\\]").length).toBe(2)
  cleanup()

  const system = render(
    <AppBar {...appBarProps()} bridge={bridge("darwin")} windowDecoration="system" />,
  )
  expect(system.container.querySelectorAll("[aria-hidden=\"true\"].w-\\[64px\\]").length).toBe(0)
})
