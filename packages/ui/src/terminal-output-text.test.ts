import { describe, expect, it } from "vitest"

import { terminalBufferOutput, terminalBufferText } from "./terminal-output-text"

type Line = { text: string, wrapped?: boolean }

function buffer(lines: readonly Line[]) {
  return {
    length: lines.length,
    getLine: (y: number) => {
      const line = lines[y]
      // Like xterm, a row keeps its trailing blanks unless asked to trim them.
      return line
        ? { isWrapped: line.wrapped ?? false, translateToString: (trimRight?: boolean) => trimRight ? line.text.trimEnd() : line.text }
        : undefined
    },
  }
}

describe("terminalBufferText", () => {
  it("joins the rows the terminal shows, one line each", () => {
    expect(terminalBufferText(buffer([{ text: "$ pnpm test" }, { text: " PASS  webhooks" }]))).toBe("$ pnpm test\n PASS  webhooks")
  })

  // A row the terminal wrapped is the same line of output, so it is joined
  // back rather than split where the pane happened to be narrow.
  it("joins a wrapped row onto the line it continues", () => {
    expect(terminalBufferText(buffer([{ text: "a long" }, { text: " line", wrapped: true }, { text: "next" }]))).toBe("a long line\nnext")
  })

  // Blanks at the end of a row the next row continues are part of the line:
  // "abc  def" wrapped at width 5 is "abc  " then "def", not "abcdef".
  it("keeps the blanks where a wrapped line was split", () => {
    expect(terminalBufferText(buffer([{ text: "abc  " }, { text: "def  ", wrapped: true }, { text: "next " }]))).toBe("abc  def\nnext")
  })

  it("drops the empty rows below the last output", () => {
    expect(terminalBufferText(buffer([{ text: "$ ls" }, { text: "" }, { text: "" }]))).toBe("$ ls")
  })

  it("is empty when nothing was printed", () => {
    expect(terminalBufferText(buffer([{ text: "" }, { text: "" }]))).toBe("")
  })

  // The attachment has a byte limit, and the end of the output is the part
  // that matters, so a long scrollback keeps its last lines.
  it("keeps the newest lines inside the byte limit", () => {
    const text = terminalBufferText(buffer([{ text: "first" }, { text: "second" }, { text: "third" }]), 12)
    expect(text).toBe("second\nthird")
  })

  it("keeps the tail of a single line past the limit", () => {
    expect(terminalBufferText(buffer([{ text: "abcdefghij" }]), 4)).toBe("ghij")
  })

  it("counts bytes, not characters, against the limit", () => {
    expect(terminalBufferText(buffer([{ text: "ok" }, { text: "ééé" }]), 6)).toBe("ééé")
  })

  // Whoever attaches the text has to say when the limit cut its start.
  it("says whether the limit cut anything", () => {
    expect(terminalBufferOutput(buffer([{ text: "first" }, { text: "second" }]), 12)).toEqual({ text: "first\nsecond", truncated: false })
    expect(terminalBufferOutput(buffer([{ text: "first" }, { text: "second" }, { text: "third" }]), 12)).toEqual({ text: "second\nthird", truncated: true })
    expect(terminalBufferOutput(buffer([{ text: "abcdefghij" }]), 4)).toEqual({ text: "ghij", truncated: true })
  })
})
