import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

// The chevron draws once per TurnActivity render, so counting it counts renders.
const chevronRenders = vi.fn()

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>()
  return {
    ...actual,
    ChevronRightIcon: (props: Record<string, unknown>) => {
      chevronRenders()
      return <span data-testid="chevron" {...props} />
    },
  }
})

const { TurnActivity } = await import("./turn-activity")
type ToolActivity = import("./turn-activity").ToolActivity

afterEach(() => {
  cleanup()
  chevronRenders.mockClear()
})

const items: ToolActivity[] = [
  { id: "1", name: "read", argument: "src/webhooks/handler.ts", outcome: "read 240 lines" },
]

// A streaming reply re-renders the thread once per token. Every row above the
// one that is growing has the same tool calls it had a token ago.
it("does not draw again when its tool calls are the same objects", () => {
  const { rerender } = render(<TurnActivity items={items} running={false} />)
  expect(chevronRenders).toHaveBeenCalledTimes(1)

  rerender(<TurnActivity items={items} running={false} />)
  rerender(<TurnActivity items={items} running={false} />)
  expect(chevronRenders).toHaveBeenCalledTimes(1)
})

it("draws again when the tool calls change", () => {
  const { rerender } = render(<TurnActivity items={items} running={false} />)
  rerender(<TurnActivity items={[...items, { id: "2", name: "test", outcome: "ok" }]} running={false} />)
  expect(chevronRenders).toHaveBeenCalledTimes(2)
})

it("draws again when the turn stops running", () => {
  const { rerender } = render(<TurnActivity items={items} running />)
  rerender(<TurnActivity items={items} running={false} />)
  expect(chevronRenders).toHaveBeenCalledTimes(2)
})
