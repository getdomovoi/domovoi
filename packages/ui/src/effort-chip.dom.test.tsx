import type { ProviderModel, Runtime } from "@getdomovoi/protocol"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { EffortChip } from "./mode-chip"

afterEach(cleanup)

const runtime: Runtime = { provider: "codex", model: "gpt-5.3-codex", reasoning: "medium", permissionMode: "build", auto: false }

function model(provider: string, supportedReasoningEfforts: string[], defaultReasoningEffort = "medium"): ProviderModel {
  return { provider, id: "gpt-5.3-codex", displayName: "gpt-5.3-codex", description: "", supportedReasoningEfforts, defaultReasoningEffort, isDefault: true }
}

// Desktop V2 draws effort as its own chip beside the mode: the shared word for
// the current level with bars, opening "EFFORT ON <HARNESS>" with the harness's
// own name for the scale, one row per level (word, the value sent in mono, a
// line), and the rule for when a change lands.
it("shows the current level and opens the harness's own scale", async () => {
  const user = userEvent.setup()
  render(<EffortChip runtime={runtime} model={model("codex", ["low", "medium", "high"])} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "Medium" }))
  const menu = screen.getByRole("menu")
  expect(within(menu).getByText("EFFORT ON CODEX")).toBeTruthy()
  expect(within(menu).getByText("reasoning effort")).toBeTruthy()
  const rows = within(menu).getAllByRole("menuitemradio")
  expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["false", "true", "false"])
  expect(within(rows[0]!).getByText("Low")).toBeTruthy()
  expect(within(rows[0]!).getByText("low")).toBeTruthy()
  expect(within(rows[0]!).getByText("Answers quickly and stops reasoning early. Fine for triage.")).toBeTruthy()
  expect(within(rows[2]!).getByText("Reasons longer before acting. Noticeably slower per turn.")).toBeTruthy()
  expect(within(menu).getByText("Applies from the next turn. A turn already in flight keeps the effort it started with.")).toBeTruthy()
})

it("sends a picked level as the session's runtime", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn()
  render(<EffortChip runtime={runtime} model={model("codex", ["low", "medium", "high"])} pending={false} onSetRuntime={onSetRuntime} />)
  await user.click(screen.getByRole("button", { name: "Medium" }))
  await user.click(screen.getByRole("menuitemradio", { name: /^High/ }))
  expect(onSetRuntime).toHaveBeenCalledWith({ ...runtime, reasoning: "high" })
})

// A harness that reports no levels shows no chip at all, as the design hides it.
it("draws no chip for a model that reports no efforts, or when no model is known", () => {
  const view = render(<EffortChip runtime={runtime} model={model("codex", [])} pending={false} onSetRuntime={vi.fn()} />)
  expect(screen.queryByRole("button")).toBeNull()
  view.rerender(<EffortChip runtime={runtime} model={undefined} pending={false} onSetRuntime={vi.fn()} />)
  expect(screen.queryByRole("button")).toBeNull()
})

// Rows come from what the model reports, not from the design's sample scale.
// A level the design names for this harness gets its word and line; one it
// does not name shows the value the harness reported, with no line.
it("lists the levels the model reports, including ones the design does not name", async () => {
  const user = userEvent.setup()
  render(<EffortChip runtime={{ ...runtime, reasoning: "xhigh" }} model={model("codex", ["low", "xhigh"], "xhigh")} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "xhigh" }))
  const rows = screen.getAllByRole("menuitemradio")
  expect(rows).toHaveLength(2)
  expect(within(rows[1]!).getByText("xhigh")).toBeTruthy()
  expect(rows[1]!.textContent).toBe("xhigh")
})

it("says a level moved when a model change could not carry it", async () => {
  const user = userEvent.setup()
  render(<EffortChip runtime={{ ...runtime, provider: "opencode", reasoning: "high" }} model={model("opencode", ["low", "high"], "high")} dropped={{ from: "Max", to: "High" }} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "High" }))
  expect(screen.getByText("opencode has no Max, so this moved to High when you changed model. It stays there.")).toBeTruthy()
  expect(screen.queryByText(/A turn already in flight/)).toBeNull()
})

it("locks the chip while a runtime update is pending", () => {
  render(<EffortChip runtime={runtime} model={model("codex", ["low", "medium", "high"])} pending onSetRuntime={vi.fn()} />)
  expect((screen.getByRole("button", { name: "Medium" }) as HTMLButtonElement).disabled).toBe(true)
})

// Some of the design's lines say a level is the default. Each model reports
// its own default, so such a line shows only on the level the model reports
// as its default, and any other level gets no line rather than a false claim.
it("shows a line that claims the default only on the model's reported default", async () => {
  const user = userEvent.setup()
  const view = render(<EffortChip runtime={runtime} model={model("codex", ["low", "medium", "high"], "high")} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "Medium" }))
  let rows = screen.getAllByRole("menuitemradio")
  expect(rows[1]!.textContent).toBe("Mediummedium")
  expect(screen.queryByText(/^The default\./)).toBeNull()
  expect(within(rows[2]!).getByText("Reasons longer before acting. Noticeably slower per turn.")).toBeTruthy()

  view.rerender(<EffortChip runtime={runtime} model={model("codex", ["low", "medium", "high"], "medium")} pending={false} onSetRuntime={vi.fn()} />)
  rows = screen.getAllByRole("menuitemradio")
  expect(within(rows[1]!).getByText("The default. Balances the time it spends against what it catches.")).toBeTruthy()
})

it("holds the Default level's line to a model that reports Default as its default", async () => {
  const user = userEvent.setup()
  const opencode = { ...runtime, provider: "opencode", reasoning: "high" }
  const view = render(<EffortChip runtime={opencode} model={model("opencode", ["default", "low", "high"], "high")} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "High" }))
  let rows = screen.getAllByRole("menuitemradio")
  expect(rows[0]!.textContent).toBe("Defaultdefault")
  expect(screen.queryByText("Whatever the model does unprompted. The only level that is not a choice.")).toBeNull()

  view.rerender(<EffortChip runtime={opencode} model={model("opencode", ["default", "low", "high"], "default")} pending={false} onSetRuntime={vi.fn()} />)
  rows = screen.getAllByRole("menuitemradio")
  expect(within(rows[0]!).getByText("Whatever the model does unprompted. The only level that is not a choice.")).toBeTruthy()
})
