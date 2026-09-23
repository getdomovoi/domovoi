import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import { workspaceUiStorageKey } from "./workspace-persistence"
import {
  completeHandshake,
  installFakeWebSocket,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness

beforeEach(() => {
  try {
    localStorage.removeItem(workspaceUiStorageKey)
  } catch {
    // A browser without storage starts from the default layout anyway.
  }
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
})

const start = async () => {
  render(<WorkspaceShell />)
  await act(async () => {
    completeHandshake(harness.socket(0), workspaceSnapshot())
  })
  await settle()
}

const actionRow = () => {
  const row = document.querySelector("[data-workspace-composer-actions]")
  if (!row) throw new Error("The composer draws no action row")
  return row as HTMLElement
}

const openEditor = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(within(actionRow()).getByRole("button", { name: "Expand prompt editor" }))
  await settle()
  return screen.getByRole("dialog", { name: "Prompt editor" })
}

// The editor exists so a long prompt can be written without losing the context
// it will run under, so the control that opens it belongs in the row that
// carries that context.
it("opens the prompt editor from the composer action row", async () => {
  const user = userEvent.setup()
  await start()

  expect(screen.queryByRole("dialog", { name: "Prompt editor" })).toBeNull()
  const editor = await openEditor(user)
  expect(within(editor).getByRole("textbox", { name: "Prompt editor message" })).toBeDefined()
})

// The design draws the expand control after the sheet opener and before the
// spacer, so the row reads as what you send with, then where you look, then
// how much room you have to write.
it("draws the expand control after the sheet opener", async () => {
  await start()

  const buttons = within(actionRow()).getAllByRole("button")
  const names = buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "")
  const sheet = names.findIndex((name) => name === "Open the sheet")
  const expand = names.findIndex((name) => name === "Expand prompt editor")
  expect(sheet).toBeGreaterThan(-1)
  expect(expand).toBe(sheet + 1)
})

// The draft is one draft. An editor that opened empty, or that threw away what
// was typed in it, would be a second composer rather than a larger one.
it("carries the draft both ways", async () => {
  const user = userEvent.setup()
  await start()

  await user.type(screen.getByRole("textbox", { name: "Message" }), "from the composer")
  const editor = await openEditor(user)

  const field = within(editor).getByRole("textbox", { name: "Prompt editor message" })
  expect((field as HTMLTextAreaElement).value).toBe("from the composer")

  await user.type(field, " and back")
  await user.click(within(editor).getByRole("button", { name: "Keep as draft" }))
  await settle()

  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
    "from the composer and back",
  )
})

// v1's editor lost every piece of context when it opened. These three chips are
// the whole reason this one exists, so they read the composer's own values.
it("shows the machine, model and mode the turn will run under", async () => {
  const user = userEvent.setup()
  await start()

  const editor = await openEditor(user)
  const footer = within(editor).getByRole("group", { name: "What this turn runs under" })
  expect(within(footer).getByText("macbook-pro-m3")).toBeDefined()
  expect(within(footer).getByText("sonnet-4.6")).toBeDefined()
  expect(within(footer).getByText("build")).toBeDefined()
})

// The control swaps both the chips and the placeholder, because the two say the
// same thing twice: what this field expects you to write.
it("swaps the insert chips and the placeholder between prose and markdown", async () => {
  const user = userEvent.setup()
  await start()

  const editor = await openEditor(user)
  const field = within(editor).getByRole("textbox", { name: "Prompt editor message" })
  expect(field.getAttribute("placeholder")).toContain("Plain prose")
  expect(within(editor).getByRole("button", { name: "@file" })).toBeDefined()

  await user.click(within(editor).getByRole("radio", { name: "Markdown" }))
  await settle()

  expect(field.getAttribute("placeholder")).toContain("Markdown")
  expect(within(editor).getByRole("button", { name: "```diff" })).toBeDefined()
  expect(within(editor).queryByRole("button", { name: "@file" })).toBeNull()
})

// A long prompt often starts before the mouse does, so the editor answers a
// shortcut as well as the control.
it("opens on the keyboard shortcut", async () => {
  const user = userEvent.setup()
  await start()

  expect(screen.queryByRole("dialog", { name: "Prompt editor" })).toBeNull()
  await user.keyboard("{Meta>}{Shift>}E{/Shift}{/Meta}")
  await settle()
  expect(screen.getByRole("dialog", { name: "Prompt editor" })).toBeDefined()
})

// Clicking the scrim closes it and clicking the card does not. A modal that
// closed on any click would throw away a long prompt on a stray one.
it("closes on the scrim but not on the card", async () => {
  const user = userEvent.setup()
  await start()

  const editor = await openEditor(user)
  await user.click(editor)
  await settle()
  expect(screen.queryByRole("dialog", { name: "Prompt editor" })).not.toBeNull()

  const scrim = document.querySelector("[data-prompt-editor-scrim]")
  if (!scrim) throw new Error("The editor draws no scrim")
  await user.click(scrim as HTMLElement)
  await settle()
  expect(screen.queryByRole("dialog", { name: "Prompt editor" })).toBeNull()
})
