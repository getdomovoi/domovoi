import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { MarkdownQuickView } from "./markdown-quick-view"

describe("MarkdownQuickView block rendering", () => {
  it("renders a heading and the paragraphs around it", () => {
    const { container } = render(<MarkdownQuickView source={"# Title\n\nfinished paragraph\n\nlast line"} />)

    expect(container.querySelector("h1")?.textContent).toBe("Title")
    expect([...container.querySelectorAll("p")].map((node) => node.textContent)).toEqual([
      "finished paragraph",
      "last line",
    ])
  })

  it("renders a fenced code block as one block, blank line and all", () => {
    const { container } = render(<MarkdownQuickView source={"intro\n\n```\nconst a = 1\n\nconst b = 2\n```"} />)

    const blocks = container.querySelectorAll("pre")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.textContent).toBe("const a = 1\n\nconst b = 2\n")
  })

  it("renders a loose list as a single list", () => {
    const { container } = render(<MarkdownQuickView source={"- first\n\n- second"} />)

    expect(container.querySelectorAll("ul")).toHaveLength(1)
    expect([...container.querySelectorAll("li")].map((node) => node.textContent?.trim())).toEqual(["first", "second"])
  })

  it("resolves a link reference defined below the text that uses it", () => {
    const { container } = render(<MarkdownQuickView source={"see [docs][d]\n\n[d]: https://example.com"} />)

    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com")
  })
})
