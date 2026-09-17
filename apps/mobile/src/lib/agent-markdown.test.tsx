import { describe, expect, it } from "@jest/globals"

import { parseAgentMarkdown, parseInlineSpans } from "./agent-markdown"

describe("what an agent writes", () => {
  it("keeps a fenced command as code rather than showing its fence", () => {
    // Measured on a real phone 2026-09-16: this reply rendered with its
    // backticks and ```zsh visible, and the command in the prose face.
    const blocks = parseAgentMarkdown([
      "To do it yourself in zsh:",
      "",
      "```zsh",
      "printf 'hello\\n' > /tmp/domovoi-gate-test.txt",
      "```",
      "",
      "If you expected me to have write access, the tool set is what's missing.",
    ].join("\n"))

    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toEqual({
      kind: "code",
      language: "zsh",
      text: "printf 'hello\\n' > /tmp/domovoi-gate-test.txt",
    })
    expect(blocks[0]!.kind).toBe("paragraph")
    expect(blocks[2]!.kind).toBe("paragraph")
  })

  it("marks inline code so a path does not read as prose", () => {
    expect(parseInlineSpans("no `Write`, `Edit`, or Bash tool")).toEqual([
      { kind: "text", text: "no " },
      { kind: "code", text: "Write" },
      { kind: "text", text: ", " },
      { kind: "code", text: "Edit" },
      { kind: "text", text: ", or Bash tool" },
    ])
  })

  it("treats markers inside code as characters", () => {
    expect(parseInlineSpans("run `ls **/*.ts` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "ls **/*.ts" },
      { kind: "text", text: " now" },
    ])
  })

  it("keeps an unterminated fence as code rather than losing the command", () => {
    const blocks = parseAgentMarkdown("here:\n\n```sh\nrm -rf nothing")
    expect(blocks[1]).toEqual({ kind: "code", language: "sh", text: "rm -rf nothing" })
  })

  it("reads bullets, which is how a report arrives", () => {
    const blocks = parseAgentMarkdown("Passed.\n\n- 34 test files\n- 604 tests")
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "bullet", "bullet"])
    expect(blocks[1]).toMatchObject({ kind: "bullet", spans: [{ kind: "text", text: "34 test files" }] })
  })

  it("leaves prose that merely looks like markup alone", () => {
    expect(parseInlineSpans("2 * 3 * 4 is not bold")).toEqual([
      { kind: "text", text: "2 * 3 * 4 is not bold" },
    ])
  })
})
