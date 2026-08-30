import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import {
  MarkdownQuickView,
  boundedMarkdownSource,
  maximumMarkdownCharacters,
  maximumMarkdownLines,
  safeMarkdownUrl,
} from "./markdown-quick-view"

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

  it("normalizes Windows and legacy line endings without false truncation", () => {
    expect(boundedMarkdownSource("# Plan\r\n\r\nReady")).toEqual({
      source: "# Plan\n\nReady",
      truncated: false,
    })
    expect(boundedMarkdownSource("# Plan\rReady")).toEqual({
      source: "# Plan\nReady",
      truncated: false,
    })
  })

  it("still reports every genuine bound for CRLF content", () => {
    const cases = [
      Array.from({ length: maximumMarkdownLines + 1 }, () => "line").join("\r\n"),
      Array.from({ length: 17 }, () => "x".repeat(2_048)).join("\r\n").slice(0, maximumMarkdownCharacters + 64),
      `heading\r\n${"x".repeat(2_049)}`,
      `heading\r\n${" ".repeat(25)}indented`,
      `heading\r\n${"> ".repeat(13)}deep quote`,
    ]
    for (const source of cases) expect(boundedMarkdownSource(source).truncated, String(source.length)).toBe(true)
  })
})
