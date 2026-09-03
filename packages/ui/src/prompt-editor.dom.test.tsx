import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  insertAtSelection,
  promptDraftStats,
  promptEditorInserts,
  PromptEditorDialog,
} from "./prompt-editor"

afterEach(cleanup)

function renderEditor(overrides: Partial<Parameters<typeof PromptEditorDialog>[0]> = {}) {
  const onDraftChange = vi.fn()
  const onSend = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <PromptEditorDialog
      open
      draft={overrides.draft ?? "Migrate the webhook handlers"}
      pending={false}
      sendDisabled={false}
      onOpenChange={onOpenChange}
      onDraftChange={onDraftChange}
      onSend={onSend}
      projectLabel="acme-api"
      worktreeLabel="wt-billing-idem"
      {...overrides}
    />,
  )
  return { onDraftChange, onSend, onOpenChange }
}

describe("promptDraftStats", () => {
  it("counts words and characters, and names an empty draft", () => {
    expect(promptDraftStats("")).toBe("empty draft")
    expect(promptDraftStats("   ")).toBe("empty draft")
    expect(promptDraftStats("one")).toBe("1 word · 3 chars")
    expect(promptDraftStats("two words")).toBe("2 words · 9 chars")
  })
})

describe("insertAtSelection", () => {
  it("puts the insert at the caret and reports where the caret lands", () => {
    expect(insertAtSelection("check ", "@file", 6, 6)).toEqual({ value: "check @file", caret: 11 })
  })

  it("replaces the selected range rather than pushing it aside", () => {
    expect(insertAtSelection("check that", "@file", 6, 10)).toEqual({ value: "check @file", caret: 11 })
  })

  it("separates the insert from a word already typed", () => {
    expect(insertAtSelection("check", "@file", 5, 5)).toEqual({ value: "check @file", caret: 11 })
  })

  it("adds no separator at the start of an empty draft", () => {
    expect(insertAtSelection("", "@file", 0, 0)).toEqual({ value: "@file", caret: 5 })
  })

  it("clamps a caret that is past the end of the draft", () => {
    expect(insertAtSelection("hi", "@file", 99, 120)).toEqual({ value: "hi @file", caret: 8 })
  })
})

describe("PromptEditorDialog", () => {
  it("shows the project and worktree it writes for", () => {
    renderEditor()
    expect(screen.getByText("acme-api · wt-billing-idem")).toBeTruthy()
  })

  it("edits the same draft the composer holds", async () => {
    const user = userEvent.setup()
    const { onDraftChange } = renderEditor({ draft: "" })
    await user.type(screen.getByLabelText("Prompt editor message"), "x")
    expect(onDraftChange).toHaveBeenCalledWith("x")
  })

  it("offers prose inserts first and markdown inserts after the toggle", async () => {
    const user = userEvent.setup()
    renderEditor()
    for (const insert of promptEditorInserts.prose) {
      expect(screen.getByRole("button", { name: insert })).toBeTruthy()
    }
    await user.click(screen.getByRole("radio", { name: "Markdown" }))
    for (const insert of promptEditorInserts.markdown) {
      expect(screen.getByRole("button", { name: insert })).toBeTruthy()
    }
    expect(screen.queryByRole("button", { name: "@selection" })).toBeNull()
  })

  it("appends an insert to the draft it was given", async () => {
    const user = userEvent.setup()
    const { onDraftChange } = renderEditor({ draft: "check" })
    await user.click(screen.getByRole("button", { name: "@file" }))
    expect(onDraftChange).toHaveBeenCalledWith("check @file")
  })

  it("reports the draft size", () => {
    renderEditor({ draft: "two words" })
    expect(screen.getByRole("status").textContent).toContain("2 words · 9 chars")
  })

  it("sends on the same shortcut as the composer", async () => {
    const user = userEvent.setup()
    const { onSend } = renderEditor()
    await user.click(screen.getByLabelText("Prompt editor message"))
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(onSend).toHaveBeenCalledOnce()
  })

  it("refuses to send a draft the composer would refuse", async () => {
    const user = userEvent.setup()
    const { onSend } = renderEditor({ draft: "", sendDisabled: true })
    await user.click(screen.getByLabelText("Prompt editor message"))
    await user.keyboard("{Control>}{Enter}{/Control}")
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true)
  })

  it("keeps the draft when it is closed rather than sending it", async () => {
    const user = userEvent.setup()
    const { onOpenChange, onSend } = renderEditor()
    await user.click(screen.getByRole("button", { name: "Keep as draft" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSend).not.toHaveBeenCalled()
  })
})
