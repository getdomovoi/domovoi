import { demoWorkspace } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

describe("emergency stop composer", () => {
  it("keeps the composer's send control disabled while an emergency stop is pending", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const send = vi.fn(async () => {})
    render(
      <Thread
        snapshot={snapshot}
        connected
        emergencyStopPending
        onResolve={vi.fn(async () => {})}
        onSetRuntime={vi.fn(async () => {})}
        onForkSession={vi.fn(async () => {})}
        onListModels={vi.fn(async () => [])}
        onNewSession={vi.fn()}
        onSend={send}
        onCheckpoint={vi.fn(async () => {})}
        onRestoreCheckpoint={vi.fn(async () => {})}
        onPauseSession={vi.fn(async () => {})}
        onArchiveSession={vi.fn(async () => {})}
      />,
    )
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Message"), "Continue anyway")
    const sendButton = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement
    expect(sendButton.disabled).toBe(true)
    await user.click(sendButton)
    expect(send).not.toHaveBeenCalled()
  })
})
