import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { MarkdownQuickView, boundedMarkdownSource, safeMarkdownUrl } from "./markdown-quick-view"

describe("MarkdownQuickView", () => {
  it("renders useful GFM without executing embedded content", () => {
    const markup = renderToStaticMarkup(<MarkdownQuickView source={'## Plan\n\n- **safe**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n<script>alert(1)</script>\n\n![track](https://attacker/x.png)'} />)
    expect(markup).toContain("<h2")
    expect(markup).toContain("<table")
    expect(markup).toContain("font-machine")
    expect(markup).not.toContain("<script")
    expect(markup).not.toContain("<img")
  })

  it("protects links and refuses unsafe schemes", () => {
    const markup = renderToStaticMarkup(<MarkdownQuickView source={'[safe](https://example.com) [bad](javascript:alert(1))'} />)
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).not.toContain("javascript:")
    expect(safeMarkdownUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com")
    expect(safeMarkdownUrl("data:text/html,x")).toBe("")
  })

  it("bounds large input and offers a real canonical handoff", () => {
    expect(boundedMarkdownSource("x".repeat(40_000))).toMatchObject({ truncated: true })
    const markup = renderToStaticMarkup(<MarkdownQuickView source={"x".repeat(40_000)} canonicalAvailable onOpenCanonical={vi.fn()} />)
    expect(markup).toContain("Quick view truncated")
    expect(markup).toContain(">Open full plan</button>")
  })
})
