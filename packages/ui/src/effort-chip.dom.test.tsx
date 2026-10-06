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
  expect(within(rows[0]!).getByText("Stops reasoning early. Fine for triage.")).toBeTruthy()
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
// A level Domovoi has no word for shows the value it sends in mono, tagged
// No word yet, with the line that says so, and the chip reads the value too.
it("lists the levels the model reports, a level with no word as its value tagged No word yet", async () => {
  const user = userEvent.setup()
  render(<EffortChip runtime={{ ...runtime, reasoning: "thinking-long" }} model={model("codex", ["low", "thinking-long"], "low")} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "thinking-long" }))
  const rows = screen.getAllByRole("menuitemradio")
  expect(rows).toHaveLength(2)
  expect(within(rows[1]!).getByText("thinking-long")).toBeTruthy()
  expect(within(rows[1]!).getByText("No word yet")).toBeTruthy()
  expect(within(rows[1]!).getByText("Reported by the model. Domovoi has no word for this level yet, so it shows the value it sends.")).toBeTruthy()
  expect(within(rows[0]!).queryByText("No word yet")).toBeNull()
})

// Desktop V2 step 2j, ruling Q31: codex's six levels, xhigh reads Extra high.
it("draws codex's six levels with the design's words and lines", async () => {
  const user = userEvent.setup()
  render(<EffortChip runtime={runtime} model={model("codex", ["none", "minimal", "low", "medium", "high", "xhigh"], "medium")} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "Medium" }))
  const rows = screen.getAllByRole("menuitemradio")
  expect(rows.map((row) => row.textContent)).toEqual([
    "Nonenone" + "No reasoning before it answers. Fastest, and it misses things.",
    "Minimalminimal" + "The least reasoning that still plans. Fine for renames and lookups.",
    "Lowlow" + "Stops reasoning early. Fine for triage.",
    "MediummediumModel default" + "Balances the time it spends against what it catches.",
    "Highhigh" + "Reasons longer before acting. Noticeably slower per turn.",
    "Extra highxhigh" + "The longest codex will reason. Slow, for a plan you cannot check yourself.",
  ])
})

// Desktop V2 step 2k: claude-code's own effort scale, four levels, default
// High. The marker follows the model's reported default, never the harness.
it("draws claude-code's four levels with the model's default marked", async () => {
  const user = userEvent.setup()
  const claude = { ...runtime, provider: "claude-code", reasoning: "high" }
  render(<EffortChip runtime={claude} model={model("claude-code", ["low", "medium", "high", "max"], "high")} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "High" }))
  const menu = screen.getByRole("menu")
  expect(within(menu).getByText("EFFORT ON CLAUDE-CODE")).toBeTruthy()
  expect(within(menu).getByText("effort")).toBeTruthy()
  const rows = within(menu).getAllByRole("menuitemradio")
  expect(rows.map((row) => row.textContent)).toEqual([
    "Lowlow" + "Short thinking. Enough for a single-file edit or a question with one answer.",
    "Mediummedium" + "Holds a multi-file change in view while it plans.",
    "HighhighModel default" + "Thinks longer before acting. Slower per turn.",
    "Maxmax" + "The longest this model will think. Slow and dear, for a plan you cannot check yourself.",
  ])
  expect(within(menu).getAllByText("Model default")).toHaveLength(1)
})

// Ruling Q35: the marker is in the menu only; the chip names the level.
it("keeps the Model default marker off the chip", () => {
  render(<EffortChip runtime={runtime} model={model("codex", ["low", "medium", "high"], "medium")} pending={false} onSetRuntime={vi.fn()} />)
  expect(screen.getByRole("button", { name: "Medium" }).textContent).toBe("Medium")
})

// Ruling Q34: the level that sends no effort value reads Model's own.
it("names the level that sends no effort value Model's own", async () => {
  const user = userEvent.setup()
  const opencode = { ...runtime, provider: "opencode", reasoning: "unset" }
  render(<EffortChip runtime={opencode} model={model("opencode", ["unset", "low", "high", "max"], "unset")} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "Model's own" }))
  const rows = screen.getAllByRole("menuitemradio")
  expect(rows[0]!.textContent).toBe("Model's ownunsetModel default" + "Sends no effort value, so the model uses its own setting.")
  expect(rows[3]!.textContent).toBe("Maxmax" + "The longest this model will reason. Slow and dear, for a plan you cannot check yourself.")
})

// A value another harness's scale names reads as that word on any harness,
// with no line, so claude-code's xhigh is Extra high as it is on codex.
it("reads a shared value with its word and no line on a harness whose scale lacks it", async () => {
  const user = userEvent.setup()
  const claude = { ...runtime, provider: "claude-code", reasoning: "xhigh" }
  render(<EffortChip runtime={claude} model={model("claude-code", ["high", "xhigh"], "high")} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "Extra high" }))
  expect(screen.getAllByRole("menuitemradio")[1]!.textContent).toBe("Extra highxhigh")
})

// The note names the model's default when the level moved there, and only
// the level otherwise. Either way it holds until a level is picked.
it("says a level moved to the model's default when a model change could not carry it", async () => {
  const user = userEvent.setup()
  render(<EffortChip runtime={{ ...runtime, provider: "opencode", reasoning: "high" }} model={model("opencode", ["low", "high"], "high")} dropped={{ from: "Max", to: "High", toDefault: true }} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "High" }))
  expect(screen.getByText("opencode has no Max, so this moved to the model's default, High. It stays until you pick a level.")).toBeTruthy()
  expect(screen.queryByText(/A turn already in flight/)).toBeNull()
})

it("says a level moved to the nearest level when the model names no default", async () => {
  const user = userEvent.setup()
  render(<EffortChip runtime={{ ...runtime, provider: "opencode", reasoning: "high" }} model={model("opencode", ["low", "high"], "none")} dropped={{ from: "Max", to: "High", toDefault: false }} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "High" }))
  expect(screen.getByText("opencode has no Max, so this moved to High. It stays until you pick a level.")).toBeTruthy()
})

it("locks the chip while a runtime update is pending", () => {
  render(<EffortChip runtime={runtime} model={model("codex", ["low", "medium", "high"])} pending onSetRuntime={vi.fn()} />)
  expect((screen.getByRole("button", { name: "Medium" }) as HTMLButtonElement).disabled).toBe(true)
})

// Desktop V2: the note after a model change is neutral, not a warning.
it("draws the moved-effort note in neutral colours", async () => {
  const user = userEvent.setup()
  render(<EffortChip runtime={{ ...runtime, provider: "opencode", reasoning: "high" }} model={model("opencode", ["low", "high"], "high")} dropped={{ from: "Max", to: "High", toDefault: true }} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "High" }))
  const note = screen.getByText(/so this moved to/)
  expect(note.className).toContain("text-foreground")
  expect(note.className).toContain("bg-accent")
  expect(note.className).not.toMatch(/warn/)
})

// Ruling Q36 B: a model that reports levels but none of them as its default
// gets no marker, and the menu says so.
it("says when the model reports no default among its levels", async () => {
  const user = userEvent.setup()
  const view = render(<EffortChip runtime={runtime} model={model("codex", ["low", "medium", "high"], "none")} pending={false} onSetRuntime={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: "Medium" }))
  expect(screen.queryByText("Model default")).toBeNull()
  expect(screen.getByText("No default reported by this model.")).toBeTruthy()
  view.rerender(<EffortChip runtime={runtime} model={model("codex", ["low", "medium", "high"], "medium")} pending={false} onSetRuntime={vi.fn()} />)
  expect(screen.queryByText("No default reported by this model.")).toBeNull()
})
