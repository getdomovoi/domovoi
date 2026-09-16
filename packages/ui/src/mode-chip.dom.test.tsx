import type { Runtime } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { ModeChip, ThinkChip } from "./mode-chip"

afterEach(cleanup)

const runtime: Runtime = { provider: "claude", model: "claude-sonnet-4.6", reasoning: "medium", permissionMode: "build", auto: false }

// v2's mode chip reads the mode, "Build · auto" when auto is on, and opens
// "MODE FOR THE NEXT TURN" with the three modes and an Auto row that is only
// live in Build, with the reason said when it is not.
it("names the mode on the chip and offers the three modes with their notes", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn()
  render(<ModeChip runtime={runtime} pending={false} onSetRuntime={onSetRuntime} />)
  await user.click(screen.getByRole("button", { name: /^Mode: Build/ }))
  expect(screen.getByText("MODE FOR THE NEXT TURN")).toBeTruthy()
  const options = screen.getAllByRole("option")
  expect(options.map((option) => option.getAttribute("aria-label"))).toEqual(["Plan", "Ask", "Build"])
  expect(options[2]!.getAttribute("aria-selected")).toBe("true")
  expect(within(options[0]!).getByText("Reads and proposes. It cannot write or run anything.")).toBeTruthy()
  await user.click(options[1]!)
  expect(onSetRuntime).toHaveBeenCalledWith({ ...runtime, permissionMode: "ask", auto: false })
})

it("offers Auto only in Build, clears it on leaving Build, and says why elsewhere", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn()
  const view = render(<ModeChip runtime={runtime} pending={false} onSetRuntime={onSetRuntime} />)
  await user.click(screen.getByRole("button", { name: /^Mode: Build/ }))
  const auto = screen.getByRole("switch", { name: "Auto" }) as HTMLButtonElement
  expect(auto.disabled).toBe(false)
  await user.click(auto)
  expect(onSetRuntime).toHaveBeenCalledWith({ ...runtime, auto: true })

  view.rerender(<ModeChip runtime={{ ...runtime, auto: true }} pending={false} onSetRuntime={onSetRuntime} />)
  expect(screen.getByRole("button", { name: /^Mode: Build · auto/ })).toBeTruthy()

  // The surface is still open from the click above; the mode changing under
  // it does not close it.
  view.rerender(<ModeChip runtime={{ ...runtime, permissionMode: "plan" }} pending={false} onSetRuntime={onSetRuntime} />)
  expect(screen.getByRole("button", { name: /^Mode: Plan/ })).toBeTruthy()
  expect((screen.getByRole("switch", { name: "Auto" }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/Only legal with Build/)).toBeTruthy()
})

it("locks the chips while a runtime update is pending", () => {
  render(<><ModeChip runtime={runtime} pending onSetRuntime={vi.fn()} /><ThinkChip runtime={runtime} options={["low", "medium", "high"]} pending onSetRuntime={vi.fn()} /></>)
  expect((screen.getByRole("button", { name: /^Mode: Build/ }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole("button", { name: /^Think: medium/ }) as HTMLButtonElement).disabled).toBe(true)
})

// v2 draws no reasoning control. The runtime has one, so it stays reachable
// as a plain chip beside the mode, offering what the model reports.
it("changes the reasoning effort from a plain chip, or says the model reports none", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn()
  const view = render(<ThinkChip runtime={runtime} options={["low", "medium", "high"]} pending={false} onSetRuntime={onSetRuntime} />)
  await user.click(screen.getByRole("button", { name: /^Think: medium/ }))
  await user.click(screen.getByRole("menuitem", { name: "high" }))
  expect(onSetRuntime).toHaveBeenCalledWith({ ...runtime, reasoning: "high" })
  view.rerender(<ThinkChip runtime={runtime} options={[]} pending={false} onSetRuntime={onSetRuntime} />)
  const chip = screen.getByRole("button", { name: /^Think: medium/ }) as HTMLButtonElement
  expect(chip.disabled).toBe(true)
  expect(chip.title).toMatch(/reports no reasoning/)
})
