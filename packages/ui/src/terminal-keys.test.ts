import { describe, expect, it } from "vitest"

import { terminalQuickKeyData, terminalQuickKeys } from "./terminal-keys"

describe("terminalQuickKeys", () => {
  it("maps the tablet handoff keys to terminal input", () => {
    expect(terminalQuickKeys).toEqual([
      { label: "esc", ariaLabel: "Escape", data: "\u001b" },
      { label: "tab", ariaLabel: "Tab", data: "\t" },
      { label: "⌃C", ariaLabel: "Control C", data: "\u0003" },
      { label: "⌃D", ariaLabel: "Control D", data: "\u0004" },
      { label: "↑", ariaLabel: "Up arrow", data: { normal: "\u001b[A", application: "\u001bOA" } },
      { label: "↓", ariaLabel: "Down arrow", data: { normal: "\u001b[B", application: "\u001bOB" } },
      { label: "|", ariaLabel: "Pipe", data: "|" },
      { label: "~", ariaLabel: "Tilde", data: "~" },
      { label: "/", ariaLabel: "Slash", data: "/" },
    ])
  })

  it("encodes cursor keys for the terminal cursor mode", () => {
    const up = terminalQuickKeys.find((key) => key.ariaLabel === "Up arrow")!

    expect(terminalQuickKeyData(up, false)).toBe("\u001b[A")
    expect(terminalQuickKeyData(up, true)).toBe("\u001bOA")
    expect(terminalQuickKeyData(terminalQuickKeys[0]!, true)).toBe("\u001b")
  })
})
