import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { StopMenu } from "./stop-menu.js"

afterEach(cleanup)

describe("StopMenu", () => {
  it("keeps pausing and killing apart, each saying what it does", async () => {
    const user = userEvent.setup()
    const onPauseAll = vi.fn()
    const onEmergencyStop = vi.fn()
    render(<StopMenu connected pending={false} onPauseAll={onPauseAll} onEmergencyStop={onEmergencyStop} />)

    await user.click(screen.getByRole("button", { name: "Stop everything" }))
    expect(screen.getByText("Stops at the next turn boundary, nothing is killed.")).toBeTruthy()
    expect(screen.getByText("Kills processes now. Half-written files stay half-written.")).toBeTruthy()

    await user.click(screen.getByRole("menuitem", { name: /Pause everything/ }))
    expect(onPauseAll).toHaveBeenCalledTimes(1)
    expect(onEmergencyStop).not.toHaveBeenCalled()
  })

  it("sends the kill only from its own item", async () => {
    const user = userEvent.setup()
    const onPauseAll = vi.fn()
    const onEmergencyStop = vi.fn()
    render(<StopMenu connected pending={false} onPauseAll={onPauseAll} onEmergencyStop={onEmergencyStop} />)

    await user.click(screen.getByRole("button", { name: "Stop everything" }))
    await user.click(screen.getByRole("menuitem", { name: /Emergency stop/ }))
    expect(onEmergencyStop).toHaveBeenCalledTimes(1)
    expect(onPauseAll).not.toHaveBeenCalled()
  })

  it("is unavailable while disconnected or while a stop is on its way, and opens nothing", async () => {
    const user = userEvent.setup()
    for (const props of [{ connected: false, pending: false }, { connected: true, pending: true }]) {
      render(<StopMenu {...props} onPauseAll={vi.fn()} onEmergencyStop={vi.fn()} />)
      const stop = screen.getByRole("button", { name: "Stop everything" })
      expect(stop.getAttribute("aria-disabled")).toBe("true")
      await user.click(stop)
      expect(screen.queryByRole("menu")).toBeNull()
      cleanup()
    }
  })
})
