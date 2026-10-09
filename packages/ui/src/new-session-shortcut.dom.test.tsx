import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  installFakeWebSocket,
  workspaceSnapshot,
  type FakeWebSocketHarness,
} from "./test-support/fake-websocket"

let harness: FakeWebSocketHarness

beforeEach(() => {
  harness = installFakeWebSocket()
})

afterEach(() => {
  cleanup()
  harness.uninstall()
  vi.restoreAllMocks()
  document.querySelectorAll("[data-test-terminal]").forEach((node) => node.remove())
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

async function openShell(clientKind: "desktop" | "web", snapshot = workspaceSnapshot()) {
  render(<WorkspaceShell clientKind={clientKind} />)
  await act(async () => {
    completeHandshake(harness.socket(0), snapshot)
  })
}

function press(init: KeyboardEventInit, target: EventTarget = globalThis): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}

const launcher = () => screen.queryByRole("dialog", { name: "Start a session" })

// The title bar's New session tip names mod+N. The desktop binds it to the
// same action as the button; a browser tab never receives Cmd+N or Ctrl+N,
// so the browser names no shortcut (Q41 A, as Q291 A for mod+shift+D and M).
describe("the new session shortcut", () => {
  it("opens the session launcher in the desktop with Ctrl+N", async () => {
    await openShell("desktop")

    const event = press({ ctrlKey: true })
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(launcher()).not.toBeNull()
  })

  it("uses Cmd+N on macOS and leaves Ctrl+N to the text field", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel")
    await openShell("desktop")

    const control = press({ ctrlKey: true })
    await settle()
    expect(control.defaultPrevented).toBe(false)
    expect(launcher()).toBeNull()

    const command = press({ metaKey: true })
    await settle()
    expect(command.defaultPrevented).toBe(true)
    expect(launcher()).not.toBeNull()
  })

  it("names the shortcut in the desktop's title bar tip", async () => {
    const user = userEvent.setup()
    await openShell("desktop")

    await user.hover(screen.getByRole("button", { name: "New session" }))
    expect((await screen.findByRole("tooltip")).textContent).toBe("New session · Ctrl+N")
  })

  it("leaves Ctrl+N to the browser and names no shortcut there", async () => {
    const user = userEvent.setup()
    await openShell("web")

    const event = press({ ctrlKey: true })
    await settle()
    expect(event.defaultPrevented).toBe(false)
    expect(launcher()).toBeNull()

    await user.hover(screen.getByRole("button", { name: "New session" }))
    expect((await screen.findByRole("tooltip")).textContent).toBe("New session")
  })

  // Ctrl+N is the shell's next-history key, so a focused terminal keeps it.
  it("leaves the key to a focused terminal", async () => {
    await openShell("desktop")
    const terminal = document.createElement("div")
    terminal.className = "xterm"
    terminal.dataset.testTerminal = ""
    const input = document.createElement("textarea")
    terminal.append(input)
    document.body.append(terminal)
    input.focus()

    const event = press({ ctrlKey: true }, input)
    await settle()

    expect(event.defaultPrevented).toBe(false)
    expect(launcher()).toBeNull()
  })

  it("does nothing while the palette is open", async () => {
    const user = userEvent.setup()
    await openShell("desktop")
    await user.keyboard("{Control>}k{/Control}")
    await screen.findByRole("combobox")

    await user.keyboard("{Control>}n{/Control}")
    await settle()

    expect(launcher()).toBeNull()
    expect(screen.getByRole("combobox")).toBeTruthy()
  })

  it("does nothing in a watching window, where the button is disabled", async () => {
    await openShell("desktop", { ...workspaceSnapshot(), clientAccess: "watching" })

    const event = press({ ctrlKey: true })
    await settle()

    expect(event.defaultPrevented).toBe(false)
    expect(launcher()).toBeNull()
  })

  it("leaves Ctrl+Shift+N and Ctrl+Alt+N alone", async () => {
    await openShell("desktop")

    for (const init of [{ ctrlKey: true, shiftKey: true, key: "N" }, { ctrlKey: true, altKey: true }]) {
      const event = press(init)
      await settle()
      expect(event.defaultPrevented).toBe(false)
    }
    expect(launcher()).toBeNull()
  })
})
