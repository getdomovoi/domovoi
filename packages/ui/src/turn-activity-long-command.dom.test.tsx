import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"

import { activityMeta, TurnActivity, type ToolActivity } from "./turn-activity"

afterEach(cleanup)

// Walk finding F7: a Codex turn running a quoted multi-line script put the
// whole command, thousands of characters, into the Working row, and the row
// grew into an oval over the thread. The row is one line: it names the
// command by a bounded summary of its first line, and the full text is one
// click away in the step.
const script = [
  "python3 - <<'PY'",
  ...Array.from({ length: 120 }, (_, index) => `print(\"line ${index} of a long quoted script that keeps going\")`),
  "PY",
].join("\n")

const items: ToolActivity[] = [
  { id: "read", name: "read_file", argument: "src/app.ts", outcome: "completed" },
  { id: "live", name: "command", argument: script, outcome: "running" },
]

describe("a running command longer than its row", () => {
  it("names the command by one bounded line", () => {
    const meta = activityMeta(items, true)!
    expect(script.length).toBeGreaterThan(5_000)
    expect(meta).not.toContain("\n")
    expect(meta.length).toBeLessThanOrEqual(120)
    expect(meta).toMatch(/^2 tools · running python3 - <<'PY'…$/u)
  })

  it("cuts a long single line and says it was cut", () => {
    const line = `pnpm vitest run ${"packages/ui/src/very-long-path/".repeat(20)}`
    const meta = activityMeta([{ id: "live", name: "command", argument: line, outcome: "running" }], true)!
    expect(meta.length).toBeLessThanOrEqual(120)
    expect(meta.startsWith("1 tool · running pnpm vitest run packages/ui/src/very-long-path/")).toBe(true)
    expect(meta.endsWith("…")).toBe(true)
  })

  it("leaves a short command whole", () => {
    expect(activityMeta([{ id: "live", name: "command", argument: "pnpm build", outcome: "running" }], true))
      .toBe("1 tool · running pnpm build")
  })

  it("draws only the summary in the row", () => {
    render(<TurnActivity items={items} running />)
    const row = screen.getByRole("button", { name: /^Working/u })
    expect(row.textContent).not.toContain("\n")
    expect(row.textContent!.length).toBeLessThan(160)
  })

  it("keeps the full command in the step, one click away", async () => {
    const user = userEvent.setup()
    render(<TurnActivity items={items} running />)
    await user.click(screen.getByRole("button", { name: /^Working/u }))
    const step = screen.getByRole("button", { name: /command/u })
    expect(step.getAttribute("aria-expanded")).toBe("false")
    await user.click(step)
    expect(step.getAttribute("aria-expanded")).toBe("true")
    const shown = [...document.querySelectorAll("pre")].map((node) => node.textContent)
    expect(shown).toContain(script)
  })
})
