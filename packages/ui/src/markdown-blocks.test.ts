import { describe, expect, it } from "vitest"

import { splitMarkdownBlocks } from "./markdown-blocks"

describe("splitMarkdownBlocks", () => {
  it("returns nothing for an empty source", () => {
    expect(splitMarkdownBlocks("")).toEqual([])
    expect(splitMarkdownBlocks("\n\n  \n")).toEqual([])
  })

  it("splits paragraphs separated by a blank line", () => {
    expect(splitMarkdownBlocks("first line\n\nsecond line")).toEqual(["first line", "second line"])
  })

  it("splits a heading away from the paragraph that follows it", () => {
    expect(splitMarkdownBlocks("# Title\n\nbody text")).toEqual(["# Title", "body text"])
  })

  it("keeps a fenced code block whole even when it contains a blank line", () => {
    const source = "intro\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter"
    expect(splitMarkdownBlocks(source)).toEqual(["intro", "```ts\nconst a = 1\n\nconst b = 2\n```", "after"])
  })

  it("keeps an unterminated fence in the final block", () => {
    const source = "intro\n\n```ts\nconst a = 1\n\nconst b = 2"
    expect(splitMarkdownBlocks(source)).toEqual(["intro", "```ts\nconst a = 1\n\nconst b = 2"])
  })

  it("never splits a loose list, because that would render as two lists", () => {
    const source = "- first\n\n- second"
    expect(splitMarkdownBlocks(source)).toEqual([source])
  })

  it("never splits an indented continuation away from its list item", () => {
    const source = "- first\n\n  continued here"
    expect(splitMarkdownBlocks(source)).toEqual([source])
  })

  it("never splits a blockquote that contains a blank line", () => {
    const source = "> first\n\n> second"
    expect(splitMarkdownBlocks(source)).toEqual([source])
  })

  it("does not split at all when the source defines a link reference", () => {
    const source = "see [docs][d]\n\nmore text\n\n[d]: https://example.com"
    expect(splitMarkdownBlocks(source)).toEqual([source])
  })

  it("keeps every completed block identical while the last block grows", () => {
    const before = splitMarkdownBlocks("# Title\n\nfinished paragraph\n\nstill wri")
    const after = splitMarkdownBlocks("# Title\n\nfinished paragraph\n\nstill writing this one")
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1))
    expect(after.at(-1)).toBe("still writing this one")
  })

  it("drops the blank lines between blocks rather than emitting empty blocks", () => {
    expect(splitMarkdownBlocks("one\n\n\n\ntwo")).toEqual(["one", "two"])
  })
})
