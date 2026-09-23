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
