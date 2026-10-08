import { describe, expect, it } from "vitest"

import { attachmentMarkers, terminalAttachmentText, terminalBufferOutput, terminalBufferText } from "./terminal-output-text"

type Line = { text: string, wrapped?: boolean }

function buffer(lines: readonly Line[]) {
  return {
    length: lines.length,
    getLine: (y: number) => {
      const line = lines[y]
      return line ? { isWrapped: line.wrapped ?? false, translateToString: () => line.text } : undefined
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

describe("terminalAttachmentText", () => {
  const nothingKnown = { historyFilled: false, earlierDropped: false }

  // Room for a marker is only taken when a marker is needed. Output that fits
  // the limit whole goes whole, with no marker and nothing cut.
  it("keeps output that fits the limit whole", () => {
    const lines = buffer([{ text: "first" }, { text: "second" }])
    expect(terminalAttachmentText(lines, nothingKnown, 12)).toEqual({ content: "first\nsecond", marked: undefined })
  })

  it("leads with the cut marker when the limit cuts, and still fits", () => {
    const lines = buffer(Array.from({ length: 40 }, (_, index) => ({ text: `line ${String(index).padStart(2, "0")}` })))
    const limit = attachmentMarkers.cut.length + 1 + 30
    const { content, marked } = terminalAttachmentText(lines, nothingKnown, limit)
    expect(marked).toBe("cut")
    expect(content.startsWith(`${attachmentMarkers.cut}\n`)).toBe(true)
    expect(content.endsWith("line 39")).toBe(true)
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(limit)
  })

  it("leads with what is already known missing when nothing more is cut", () => {
    const lines = buffer([{ text: "tail" }])
    expect(terminalAttachmentText(lines, { historyFilled: true, earlierDropped: true }, 1_000)).toEqual({ content: `${attachmentMarkers.history}\ntail`, marked: "history" })
    expect(terminalAttachmentText(lines, { historyFilled: false, earlierDropped: true }, 1_000)).toEqual({ content: `${attachmentMarkers.dropped}\ntail`, marked: "dropped" })
  })

  it("is empty when nothing was printed", () => {
    expect(terminalAttachmentText(buffer([{ text: "" }]), nothingKnown, 1_000)).toEqual({ content: "", marked: undefined })
  })
})
