import { demoWorkspace } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { AppBar } from "./app-bar.js"
import { SessionsDrawerTrigger } from "./sessions-drawer.js"

afterEach(cleanup)

function TitlebarSessions() {
  const [open, setOpen] = useState(false)
  return (
    <AppBar
      snapshot={demoWorkspace}
      connected
      emergencyStopPending={false}
      emergencyStopOutcome={null}
      emergencyStopError={null}
      onNewSession={vi.fn()}
      onOpenMachines={vi.fn()}
      onOpenSettings={vi.fn()}
      onPauseAll={vi.fn()}
      onEmergencyStop={vi.fn()}
      onToggleTheme={vi.fn()}
      sessionsDrawer={<SessionsDrawerTrigger snapshot={demoWorkspace} open={open} onOpenChange={setOpen} />}
    />
  )
}

it("owns session navigation from the titlebar instead of a permanent workspace rail", async () => {
  const user = userEvent.setup()
  render(<TitlebarSessions />)

  const trigger = screen.getByRole("button", { name: /Sessions/ })
  expect(trigger.getAttribute("aria-controls")).toBe("sessions-drawer")
  expect(trigger.getAttribute("aria-expanded")).toBe("false")

  await user.click(trigger)
  expect(trigger.getAttribute("aria-expanded")).toBe("true")
  expect(trigger.getAttribute("aria-label")).toMatch(/^Hide sessions/)
})
