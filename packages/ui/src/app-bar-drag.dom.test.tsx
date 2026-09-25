import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { demoWorkspace } from "@getdomovoi/protocol"

import { AppBar } from "./app-bar.js"
import type { DesktopWindowBridge } from "./desktop-platform.js"

afterEach(cleanup)

function bridge(platform: DesktopWindowBridge["platform"]): DesktopWindowBridge {
  return {
    platform,
    titlebarLeadingInset: platform === "darwin" ? 78 : 0,
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
  } as unknown as DesktopWindowBridge
}

function appBar(platform: DesktopWindowBridge["platform"]) {
  return render(
    <AppBar
      snapshot={demoWorkspace}
      connected
      emergencyStopPending={false}
      emergencyStopOutcome={null}
      emergencyStopError={null}
      bridge={bridge(platform)}
      windowDecoration="domovoi"
      onNewSession={vi.fn()}
      onOpenMachines={vi.fn()}
      onOpenSettings={vi.fn()}
      onPauseAll={vi.fn()}
      onEmergencyStop={vi.fn()}
      onOpenCommands={vi.fn()}
      onToggleTheme={vi.fn()}
      commandShortcut="⌘K"
      sessionsDrawer={<button type="button">Sessions</button>}
    />,
  )
}

// The bar itself drags the window. Anything a person can operate has to opt out,
// or the drag region swallows the click and the control silently stops working
// while still looking correct.
it("drags from the bar and exempts every control a person can operate", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    const view = appBar(platform)
    const header = view.container.querySelector("header")
    expect(header?.className).toContain("electron-drag")

    const controls = header?.querySelectorAll("button, a[href], input, select, textarea, [role='button']") ?? []
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) {
      const exempt = control.closest(".electron-no-drag")
      expect(exempt, `${platform}: ${control.textContent || control.getAttribute("aria-label")} inherits the drag region`).not.toBeNull()
    }
    cleanup()
  }
})
