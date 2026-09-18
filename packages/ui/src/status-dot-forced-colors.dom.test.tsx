import { cleanup, render } from "@testing-library/react"
import { demoWorkspace } from "@getdomovoi/protocol"
import { readFileSync } from "node:fs"
import { afterEach, expect, it, vi } from "vitest"
import { AppBar } from "./workspace-shell"

afterEach(cleanup)
it("keeps the forced-colors hook on the app bar connectivity dot", () => {
  const styles = readFileSync(`${process.cwd()}/src/styles.css`, "utf8")
  expect(styles).toContain("[data-status-dot] {")
  expect(styles).toContain("background: CanvasText !important")
  const { container } = render(<AppBar snapshot={demoWorkspace} connected emergencyStopPending={false}
    emergencyStopOutcome={null} emergencyStopError={null} onOpenProject={vi.fn()} onPauseAll={vi.fn()}
        onEmergencyStop={vi.fn()} />)
  expect(container.querySelectorAll("[data-status-dot]").length).toBeGreaterThan(0)
})
