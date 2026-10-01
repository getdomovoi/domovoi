import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

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

    await user.keyboard("{Control>}k{/Control}")
    expect(screen.getByRole("dialog", { name: "Domovoi commands" })).toBeTruthy()
    const combobox = screen.getByRole("combobox")
    expect(document.activeElement).toBe(combobox)

    await user.type(combobox, "pause everything")
    await user.keyboard("{Enter}")
    expect(sentRequests(socket, "system.pauseAll")).toHaveLength(1)
    expect(sentRequests(socket, "system.emergencyStop")).toHaveLength(0)
    await settle()
    expect(screen.queryByRole("dialog", { name: "Domovoi commands" })).toBeNull()

    await user.keyboard("{Control>}k{/Control}")
    expect(screen.getByRole("dialog", { name: "Domovoi commands" })).toBeTruthy()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "Domovoi commands" })).toBeNull()
    await settle()
    expect(document.activeElement).toBe(trigger)
  })

  it("takes a checkpoint of the active session and says why when the daemon refuses", async () => {
    const user = userEvent.setup()
    const snapshot = workspaceSnapshot()
    const active = snapshot.sessions.find((session) => session.id === snapshot.activeSessionId)!
    delete active.activeTurnId
    active.state = "idle"
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => {
      completeHandshake(socket, snapshot)
    })

    await user.keyboard("{Control>}k{/Control}")
    await user.type(screen.getByRole("combobox"), "take a checkpoint")
    await user.keyboard("{Enter}")
    expect(sentRequests(socket, "checkpoint.create")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ sessionId: active.id }) }),
    ])
    await act(async () => {
      fail(socket, "checkpoint.create", { code: -32602, message: "Stop the active turn before creating a checkpoint" })
    })
    await settle()
    expect(screen.getByText("Stop the active turn before creating a checkpoint")).toBeTruthy()
  })

  it("shows the v2 session commands with their meta and opens the sheet tabs they name", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    await user.keyboard("{Control>}k{/Control}")
    const option = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`, "u") })
    expect(option("Open the changes sheet").textContent).toContain("Ctrl+Shift+D")
    expect(option("Take a checkpoint").textContent).toContain("manual")
    expect(option("Revert to a checkpoint")).toBeTruthy()
    expect(option("Review what you have allowed").textContent).toContain("0 rules")
    expect(option("Move this session to another machine").textContent).toContain("handoff")
    expect(option("Show all machines").textContent).toContain("Ctrl+Shift+M")
    expect(option("Read the audit log").textContent).toContain("on this machine")
    // Pairing lives in the desktop's settings; a browser window has no card to open.
    expect(screen.queryByRole("option", { name: /^Pair a phone or tablet/u })).toBeNull()

    await user.type(screen.getByRole("combobox"), "open the changes sheet")
    await user.keyboard("{Enter}")
    expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")

    await user.keyboard("{Control>}k{/Control}")
    await user.type(screen.getByRole("combobox"), "review what you have allowed")
    await user.keyboard("{Enter}")
    expect(screen.getByRole("tab", { name: "Rules" }).getAttribute("aria-selected")).toBe("true")

    await user.keyboard("{Control>}k{/Control}")
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

    await user.keyboard("{Control>}k{/Control}")
    expect(screen.getByRole("option", { name: /^Pair a phone or tablet/u }).textContent).toContain("settings")
    await user.type(screen.getByRole("combobox"), "pair a phone")
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("heading", { name: "Phone and tablet" })).toBeTruthy()
  })

  it("opens the machine menu on the active session to move it", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    const socket = harness.socket(0)
    await act(async () => {
      completeHandshake(socket, workspaceSnapshot())
    })

    expect(screen.queryByRole("menu")).toBeNull()
    await user.keyboard("{Control>}k{/Control}")
    await user.type(screen.getByRole("combobox"), "move this session")
    await user.keyboard("{Enter}")
    await settle()
    const menu = await screen.findByRole("menu")
    expect(menu.textContent).toContain("Machines")
    // Choosing the machine is the menu's job; nothing moves from the palette.
    expect(sentRequests(socket, "session.transfer")).toHaveLength(0)
  })

  it("opens the changes sheet and the machines screen from the shortcuts the palette names", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    await act(async () => {
      completeHandshake(harness.socket(0), workspaceSnapshot())
    })

    await user.keyboard("{Control>}{Shift>}D{/Shift}{/Control}")
    expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")
    await user.keyboard("{Control>}{Shift>}M{/Shift}{/Control}")
    await screen.findByRole("heading", { name: "Machines" })
  })

  it("locks the move for a watching window and leaves the views open", async () => {
    const user = userEvent.setup()
    render(<WorkspaceShell />)
    await act(async () => {
      completeHandshake(harness.socket(0), { ...workspaceSnapshot(), clientAccess: "watching" })
    })

    await user.keyboard("{Control>}k{/Control}")
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

    await user.keyboard("{Control>}k{/Control}")
    await user.type(screen.getByRole("combobox"), "emergency stop")
    await user.keyboard("{Enter}")
    expect(sentRequests(socket, "system.emergencyStop")).toHaveLength(1)
    expect(sentRequests(socket, "system.pauseAll")).toHaveLength(0)
  })
})
