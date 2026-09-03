import { render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

const markdownCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock("react-markdown", () => ({
  default: (props: { children?: string }) => {
    markdownCalls.count += 1
    return <div data-testid="markdown">{props.children}</div>
  },
}))

import { MarkdownQuickView } from "./markdown-quick-view"

afterEach(() => {
  markdownCalls.count = 0
})

it("does not parse markdown again when nothing changed", () => {
  const { rerender } = render(<MarkdownQuickView source="# Plan" />)
  expect(markdownCalls.count).toBe(1)

  rerender(<MarkdownQuickView source="# Plan" />)
  rerender(<MarkdownQuickView source="# Plan" />)

  expect(markdownCalls.count).toBe(1)
})

it("parses markdown again when the source changes", () => {
  const { rerender } = render(<MarkdownQuickView source="# Plan" />)
  expect(markdownCalls.count).toBe(1)

  rerender(<MarkdownQuickView source="# Other plan" />)

  expect(markdownCalls.count).toBe(2)
})
