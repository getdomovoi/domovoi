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
  render(<><ModeChip runtime={runtime} pending onSetRuntime={vi.fn()} /><ThinkChip runtime={runtime} catalog={{ status: "ready", options: ["low", "medium", "high"] }} pending onSetRuntime={vi.fn()} /></>)
  expect((screen.getByRole("button", { name: /^Mode: Build/ }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole("button", { name: /^Think: medium/ }) as HTMLButtonElement).disabled).toBe(true)
})

// An update can start while the surface is open (toggling Auto starts one).
// The rows then hold too: a pick by mouse or keyboard goes nowhere upstream,
// so the row says so and sends nothing rather than dropping the choice.
it("holds the open mode rows while an update is pending, by mouse and by keyboard", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn()
  const view = render(<ModeChip runtime={runtime} pending={false} onSetRuntime={onSetRuntime} />)
  await user.click(screen.getByRole("button", { name: /^Mode: Build/ }))
  view.rerender(<ModeChip runtime={runtime} pending onSetRuntime={onSetRuntime} />)
  const ask = screen.getByRole("option", { name: "Ask" })
  expect(ask.getAttribute("aria-disabled")).toBe("true")
  await user.click(ask)
  ask.focus()
  await user.keyboard("{Enter}")
  expect(onSetRuntime).not.toHaveBeenCalled()
  expect(screen.getByText("MODE FOR THE NEXT TURN")).toBeTruthy()
})

// v2 draws no reasoning control. The runtime has one, so it stays reachable
// as a plain chip beside the mode, offering what the model reports.
it("changes the reasoning effort from a plain chip, or says the model reports none", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn()
  const view = render(<ThinkChip runtime={runtime} catalog={{ status: "ready", options: ["low", "medium", "high"] }} pending={false} onSetRuntime={onSetRuntime} />)
  await user.click(screen.getByRole("button", { name: /^Think: medium/ }))
  await user.click(screen.getByRole("menuitem", { name: "high" }))
  expect(onSetRuntime).toHaveBeenCalledWith({ ...runtime, reasoning: "high" })
  view.rerender(<ThinkChip runtime={runtime} catalog={{ status: "ready", options: [] }} pending={false} onSetRuntime={onSetRuntime} />)
  const chip = screen.getByRole("button", { name: /^Think: medium/ }) as HTMLButtonElement
  expect(chip.disabled).toBe(true)
  expect(chip.title).toMatch(/reports no reasoning/)
})

// "No efforts" is a claim only a finished read may make. A read still
// running or one that failed says that instead, and a failed one can be
// asked again from the chip.
it("says a read is running or failed rather than claiming the model reports none", async () => {
  const user = userEvent.setup()
  const onRetry = vi.fn()
  const view = render(<ThinkChip runtime={runtime} catalog={{ status: "loading" }} pending={false} onSetRuntime={vi.fn()} onRetry={onRetry} />)
  let chip = screen.getByRole("button", { name: /^Think: medium/ }) as HTMLButtonElement
  expect(chip.disabled).toBe(true)
  expect(chip.title).toMatch(/Reading which reasoning efforts/)
  expect(chip.title).not.toMatch(/reports no reasoning/)

  view.rerender(<ThinkChip runtime={runtime} catalog={{ status: "failed", message: "Daemon connection is not open" }} pending={false} onSetRuntime={vi.fn()} onRetry={onRetry} />)
  chip = screen.getByRole("button", { name: /^Think: medium/ }) as HTMLButtonElement
  expect(chip.disabled).toBe(false)
  expect(chip.title).toMatch(/could not be read: Daemon connection is not open/)
  await user.click(chip)
  expect(screen.getByText("Daemon connection is not open")).toBeTruthy()
  await user.click(screen.getByRole("menuitem", { name: "Read the model list again" }))
  expect(onRetry).toHaveBeenCalledTimes(1)
})

// The mode list sits at the bottom of the composer and opens upward. Rendered
// in place it was cut off by an ancestor and lost its first rows, so Plan and
// Ask could not be picked on a real screen while every test here passed: jsdom
// has no layout, so clipping is invisible to it. What a test can hold is the
// structural cause, which is that the surface renders outside the composer
// subtree rather than inside it.
it("renders the mode list outside the composer subtree, where nothing can clip it", async () => {
  const user = userEvent.setup()
  const composer = document.createElement("div")
  document.body.appendChild(composer)
  render(<ModeChip runtime={runtime} pending={false} onSetRuntime={vi.fn()} />, { container: composer })

  await user.click(screen.getByRole("button", { name: /^Mode: Build/ }))
  const plan = screen.getByRole("option", { name: "Plan" })
  expect(composer.contains(plan)).toBe(false)
  expect(document.body.contains(plan)).toBe(true)
})
