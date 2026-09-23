import { render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const parsed = vi.hoisted(() => [] as string[])

vi.mock("react-markdown", () => ({
  default: (props: { children?: string }) => {
    parsed.push(props.children ?? "")
    return <div data-testid="markdown">{props.children}</div>
  },
}))

import { MarkdownQuickView } from "./markdown-quick-view"

afterEach(() => {
  parsed.length = 0
})

describe("MarkdownQuickView while a reply streams", () => {
  it("parses a finished block once no matter how much more text arrives", () => {
    const { rerender } = render(<MarkdownQuickView source={"# Title\n\nfinished paragraph\n\nstill wri"} />)
    parsed.length = 0

    rerender(<MarkdownQuickView source={"# Title\n\nfinished paragraph\n\nstill writing this"} />)
    rerender(<MarkdownQuickView source={"# Title\n\nfinished paragraph\n\nstill writing this one now"} />)

    expect(parsed).toEqual(["still writing this", "still writing this one now"])
  })

  it("parses every block once on the first render", () => {
    render(<MarkdownQuickView source={"# Title\n\nfinished paragraph\n\nlast line"} />)

    expect(parsed).toEqual(["# Title", "finished paragraph", "last line"])
  })

  it("keeps a fenced code block in a single parse", () => {
    render(<MarkdownQuickView source={"intro\n\n```\nconst a = 1\n\nconst b = 2\n```"} />)

    expect(parsed).toEqual(["intro", "```\nconst a = 1\n\nconst b = 2\n```"])
  })
})
