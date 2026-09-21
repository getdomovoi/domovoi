import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ThreadFileChips } from "./thread-file-chips"

afterEach(cleanup)

describe("ThreadFileChips", () => {
  it("names every touched file with the counts the turn reported", () => {
    render(
      <ThreadFileChips
        files={[
          { path: "src/webhooks/handler.ts", additions: 62, deletions: 14 },
          { path: "src/webhooks/replay.ts", additions: 71, deletions: 0 },
        ]}
        onReview={vi.fn()}
      />,
    )

    expect(screen.getByText("src/webhooks/handler.ts")).toBeTruthy()
    expect(screen.getByText("+62")).toBeTruthy()
    expect(screen.getByText("−14")).toBeTruthy()
    expect(screen.getByText("src/webhooks/replay.ts")).toBeTruthy()
    expect(screen.getByText("+71")).toBeTruthy()
  })

  it("leaves the deletion count off a file that lost no lines", () => {
    render(<ThreadFileChips files={[{ path: "a.ts", additions: 71, deletions: 0 }]} onReview={vi.fn()} />)

    expect(screen.queryByText("−0")).toBeNull()
  })

  it("shows a path with no counts when the provider reported none", () => {
    render(<ThreadFileChips files={[{ path: "a.ts" }]} onReview={vi.fn()} />)

    expect(screen.getByText("a.ts")).toBeTruthy()
    expect(screen.queryByText(/^\+/)).toBeNull()
  })

  it("counts every touched file in the review chip, including the ones it does not list", () => {
    render(
      <ThreadFileChips
        files={[{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }, { path: "d.ts" }, { path: "e.ts" }]}
        onReview={vi.fn()}
      />,
    )

    expect(screen.getByText("Review all 5 changed files")).toBeTruthy()
    expect(screen.queryByText("e.ts")).toBeNull()
  })

  it("says one file in the singular", () => {
    render(<ThreadFileChips files={[{ path: "a.ts" }]} onReview={vi.fn()} />)

    expect(screen.getByText("Review the 1 changed file")).toBeTruthy()
  })

  it("merges the counts when two calls touched one file", () => {
    render(
      <ThreadFileChips
        files={[
          { path: "a.ts", additions: 4, deletions: 1 },
          { path: "a.ts", additions: 6, deletions: 2 },
        ]}
        onReview={vi.fn()}
      />,
    )

    expect(screen.getAllByText("a.ts")).toHaveLength(1)
    expect(screen.getByText("+10")).toBeTruthy()
    expect(screen.getByText("−3")).toBeTruthy()
  })

  it("opens the review surface from a file chip", async () => {
    const onReview = vi.fn()
    render(<ThreadFileChips files={[{ path: "a.ts" }]} onReview={onReview} />)

    await userEvent.click(screen.getByRole("button", { name: /a\.ts/ }))

    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it("renders nothing when the turn touched no files", () => {
    const { container } = render(<ThreadFileChips files={[]} onReview={vi.fn()} />)

    expect(container.firstChild).toBeNull()
  })
})
