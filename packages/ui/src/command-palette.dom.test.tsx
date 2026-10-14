import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { BrowserLimitsPanel } from "./browser-limits-panel"
import { WorkspaceShell } from "./workspace-shell"
import {
  completeHandshake,
  fail,
  installFakeWebSocket,
  sentRequests,
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
})

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

// The palette's code loads the first time it opens, and a dialog with its
// name stands in for it until then, so an open waits for the palette's own
// search field.
const openPalette = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.keyboard("{Control>}k{/Control}")
  await screen.findByRole("combobox")
}

describe("workspace command palette keyboard path", () => {
  it("opens with Ctrl+K, runs the selected command, and restores focus on Escape", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => {
      completeHandshake(socket, workspaceSnapshot())
    })

    const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "Open command palette" })
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await openPalette(user)
    expect(screen.getByRole("dialog", { name: "Domovoi commands" })).toBeTruthy()
    const combobox = screen.getByRole("combobox")
    expect(document.activeElement).toBe(combobox)

    await user.type(combobox, "pause everything")
    await user.keyboard("{Enter}")
    expect(sentRequests(socket, "system.pauseAll")).toHaveLength(1)
    expect(sentRequests(socket, "system.emergencyStop")).toHaveLength(0)
    await settle()
    expect(screen.queryByRole("dialog", { name: "Domovoi commands" })).toBeNull()

    await openPalette(user)
    expect(screen.getByRole("dialog", { name: "Domovoi commands" })).toBeTruthy()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "Domovoi commands" })).toBeNull()
    await settle()
    expect(document.activeElement).toBe(trigger)
  })

  it.each([false, true])("takes a checkpoint and renders real refusals while running=%s", async (running) => {
    const user = userEvent.setup()
    const snapshot = workspaceSnapshot()
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    if (running) active.activeTurnId = "turn-running"
    else delete active.activeTurnId
    active.state = running ? "active" : "idle"
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => {
      completeHandshake(socket, snapshot)
    })

    await openPalette(user)
    await user.type(screen.getByRole("combobox"), "take a checkpoint")
    await user.keyboard("{Enter}")
    expect(sentRequests(socket, "checkpoint.create")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ sessionId: active.id }) }),
    ])
    await act(async () => {
      fail(socket, "checkpoint.create", { code: -32602, message: "Session has no worktree" })
    })
    await settle()
    expect(screen.getByText("Session has no worktree")).toBeTruthy()
  })

  it("shows the v2 session commands with their meta", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    await openPalette(user)
    const option = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`, "u") })
    expect(option("Open the changes sheet")).toBeTruthy()
    expect(option("Take a checkpoint").textContent).toContain("manual")
    expect(option("Revert to a checkpoint")).toBeTruthy()
    expect(option("Review what you have allowed").textContent).toContain("0 rules")
    expect(option("Move this session to another machine").textContent).toContain("handoff")
    expect(option("Show all machines")).toBeTruthy()
    expect(option("Read the audit log").textContent).toContain("on this machine")
    // Pairing lives in the desktop's settings; a browser window has no card to open.
    expect(screen.queryByRole("option", { name: /^Pair a phone or tablet/u })).toBeNull()
  })

  it('opens the Changes tab from "open the changes sheet"', async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    await openPalette(user)
    await user.type(screen.getByRole("combobox"), "open the changes sheet")
    await user.keyboard("{Enter}")
    expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")
  })

  it('opens the Rules tab from "review what you have allowed"', async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    await openPalette(user)
    await user.type(screen.getByRole("combobox"), "review what you have allowed")
    await user.keyboard("{Enter}")
    expect(screen.getByRole("tab", { name: "Rules" }).getAttribute("aria-selected")).toBe("true")
  })

  it('opens the Checkpoints tab from "revert to a checkpoint"', async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    await openPalette(user)
    await user.type(screen.getByRole("combobox"), "revert to a checkpoint")
    await user.keyboard("{Enter}")
    expect(screen.getByRole("tab", { name: "Checkpoints" }).getAttribute("aria-selected")).toBe("true")
  })

  it("opens the desktop's pairing card from Pair a phone or tablet", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell clientKind="desktop" />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    await openPalette(user)
    expect(screen.getByRole("option", { name: /^Pair a phone or tablet/u }).textContent).toContain("settings")
    await user.type(screen.getByRole("combobox"), "pair a phone")
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("heading", { name: "Phone and tablet" })).toBeTruthy()
  })

  // Q367 A: the web hands the shell a way back to its limits page, and the
  // palette opens it with the control that opened the palette, so focus can
  // go back there. A shell given no way has no entry.
  // The page's rows name the route, so the shell hands over the word its
  // chip shows: loopback at home on loopback, the tailnet over the tailnet.
  it.each([
    ["ws://127.0.0.1:47831/rpc", "loopback"],
    ["wss://studio.example.ts.net:47831/rpc", "tailnet"],
  ] as const)("opens the browser limits page from the palette at %s, naming the opener and the route %s", async (rpcUrl, route) => {
    const user = userEvent.setup()
    const opened: unknown[][] = []
    const { unmount } = render(<WorkspaceShell clientKind="web" rpcUrl={rpcUrl} onOpenBrowserLimits={(...args) => opened.push(args)} />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "Open command palette" })
    trigger.focus()
    await openPalette(user)
    await user.type(screen.getByRole("combobox"), "what a browser tab")
    await user.keyboard("{Enter}")
    expect(opened).toEqual([[trigger, route]])
    unmount()

    render(<WorkspaceShell clientKind="web" />)
    await act(async () => {
      completeHandshake(harness.socket(1), workspaceSnapshot())
    })
    await openPalette(user)
    expect(screen.queryByRole("option", { name: /^What a browser tab can and cannot do/u })).toBeNull()
  })

  // Task 99: the open limits name the route the chip names now, so the shell
  // reports each change of that word, and none while the daemon is lost.
  it("reports the chip's route to the browser limits on each change, none while the daemon is lost", async () => {
    const routes: unknown[] = []
    render(<WorkspaceShell clientKind="web" onOpenBrowserLimits={() => undefined} onBrowserLimitsRoute={(route) => routes.push(route)} />)
    await settle()
    expect(routes).toEqual([undefined])
    await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
    await settle()
    expect(routes).toEqual([undefined, "loopback"])

    await act(async () => { harness.socket(0).drop() })
    await settle()
    expect(routes).toEqual([undefined, "loopback", undefined])

    fireEvent.click(screen.getByRole("button", { name: "Retry now" }))
    await settle()
    await act(async () => { completeHandshake(harness.sockets.at(-1)!, workspaceSnapshot()) })
    await settle()
    expect(routes).toEqual([undefined, "loopback", undefined, "loopback"])
  })

  // Task 99: the palette opened over the limits closes them, so the control
  // that had focus when it opened (the limits heading) is gone when it closes.
  // Focus goes back to the control that first opened the limits instead, and
  // the limits asked for again from that palette keep that control too.
  it("gives focus back to the limits' first opener when a palette opened over them closes", async () => {
    const user = userEvent.setup()
    const opened: Array<HTMLElement | null> = []
    function Tab() {
      const [limits, setLimits] = useState<{ open: boolean; opener: HTMLElement | null }>({ open: false, opener: null })
      return <>
        <WorkspaceShell clientKind="web" onOpenBrowserLimits={(opener) => { opened.push(opener); setLimits({ open: true, opener }) }} />
        <BrowserLimitsPanel rows={[]} continueLabel="Back" onContinue={() => setLimits((current) => ({ ...current, open: false }))} dialog={{ open: limits.open, returnFocusTo: limits.opener }} />
      </>
    }
    render(<Tab />)
    await act(async () => { completeHandshake(harness.socket(0), workspaceSnapshot()) })
    const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "Open command palette" })
    trigger.focus()
    const openLimits = async () => {
      await user.type(screen.getByRole("combobox"), "what a browser tab")
      await user.keyboard("{Enter}")
      await settle()
    }
    const limits = () => screen.queryByRole("dialog", { name: "What a browser tab can and cannot do" })

    await openPalette(user)
    await openLimits()
    expect(limits()).not.toBeNull()
    expect(document.activeElement?.textContent).toBe("What a browser tab can and cannot do")

    // The palette over the limits closes them; Escape closes the palette.
    await openPalette(user)
    expect(limits()).toBeNull()
    await user.keyboard("{Escape}")
    await settle()
    expect(document.activeElement).toBe(trigger)

    // Asked for again from a palette opened over them, they keep the trigger.
    await openPalette(user)
    await openLimits()
    await openPalette(user)
    await openLimits()
    expect(opened).toEqual([trigger, trigger, trigger])
    await user.click(screen.getByRole("button", { name: "Back" }))
    await settle()
    expect(document.activeElement).toBe(trigger)
  })

  it("opens the machine menu on the active session to move it", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => {
      completeHandshake(socket, workspaceSnapshot())
    })

    expect(screen.queryByRole("menu")).toBeNull()
    await openPalette(user)
    await user.type(screen.getByRole("combobox"), "move this session")
    await user.keyboard("{Enter}")
    await settle()
    const menu = await screen.findByRole("menu")
    expect(menu.textContent).toContain("Machines")
    // Choosing the machine is the menu's job; nothing moves from the palette.
    expect(sentRequests(socket, "session.transfer")).toHaveLength(0)
  })

  // Ruling Q291 A (2026-10-01): the desktop binds the two shortcuts and names
  // them; a browser binds neither and names neither.
  it("binds and names the changes and machines shortcuts in the desktop", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell clientKind="desktop" />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    await openPalette(user)
    const option = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`, "u") })
    expect(option("Open the changes sheet").textContent).toContain("Ctrl+Shift+D")
    expect(option("Show all machines").textContent).toContain("Ctrl+Shift+M")
    await user.type(screen.getByRole("combobox"), "review what you have allowed")
    await user.keyboard("{Enter}")
    expect(screen.getByRole("tab", { name: "Rules" }).getAttribute("aria-selected")).toBe("true")

    await user.keyboard("{Control>}{Shift>}D{/Shift}{/Control}")
    expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")
    await user.keyboard("{Control>}{Shift>}M{/Shift}{/Control}")
    await screen.findByRole("heading", { name: "Machines" })
  })

  it("leaves the changes and machines keys to the browser and names no shortcut", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell clientKind="web" />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    await openPalette(user)
    const option = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`, "u") })
    expect(option("Open the changes sheet").textContent).not.toContain("Ctrl+Shift+D")
    expect(option("Show all machines").textContent).not.toContain("Ctrl+Shift+M")
    expect(option("Open the changes sheet").querySelector("kbd")).toBeNull()
    expect(option("Show all machines").querySelector("kbd")).toBeNull()
    await user.keyboard("{Escape}")
    await settle()

    for (const key of ["D", "M"]) {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
      act(() => { globalThis.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
    }
    await settle()
    expect(screen.queryByRole("heading", { name: "Machines" })).toBeNull()
    expect(screen.queryByRole("tab", { name: "Changes", selected: true })).toBeNull()
  })

  it("locks the move for a watching window and leaves the views open", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    await act(async () => {
      completeHandshake(harness.socket(0), { ...workspaceSnapshot(), clientAccess: "watching" })
    })

    await openPalette(user)
    const option = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`, "u") })
    expect(option("Move this session to another machine").getAttribute("aria-disabled")).toBe("true")
    expect(option("Open the changes sheet").getAttribute("aria-disabled")).not.toBe("true")
    expect(option("Review what you have allowed").getAttribute("aria-disabled")).not.toBe("true")
    expect(option("Revert to a checkpoint").getAttribute("aria-disabled")).not.toBe("true")
  })

  it("sends the kill only from the emergency stop command", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => {
      completeHandshake(socket, workspaceSnapshot())
    })

    await openPalette(user)
    await user.type(screen.getByRole("combobox"), "emergency stop")
    await user.keyboard("{Enter}")
    expect(sentRequests(socket, "system.emergencyStop")).toHaveLength(1)
    expect(sentRequests(socket, "system.pauseAll")).toHaveLength(0)
  })
})
