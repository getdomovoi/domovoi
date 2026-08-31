import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ProjectSwitchConfirmationDialog } from "./workspace-shell"

const confirmation = {
  kind: "project-switch-confirmation" as const,
  requestedPath: "/code/elsewhere",
  sessions: [
    { id: "session-1", title: "First task", state: "active" as const, workspacePath: "/worktrees/session-1" },
    { id: "session-2", title: "Second task", state: "archived" as const },
  ],
  sessionCount: 2,
  worktreeCount: 1,
}

describe("ProjectSwitchConfirmationDialog", () => {
  it("lists exact impact and cancels without retry", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<ProjectSwitchConfirmationDialog confirmation={confirmation} onCancel={onCancel} onConfirm={onConfirm} />)

    expect(screen.getByText(/2 sessions and their saved history/i)).not.toBeNull()
    expect(screen.getByText(/1 isolated worktree/i)).not.toBeNull()
    expect(screen.getByText("First task")).not.toBeNull()
    expect(screen.getByText("Second task")).not.toBeNull()
    await user.click(screen.getByRole("button", { name: "Keep current project" }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("confirms one retry for the exact requested path", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ProjectSwitchConfirmationDialog confirmation={confirmation} onCancel={vi.fn()} onConfirm={onConfirm} />)

    await user.click(screen.getByRole("button", { name: "Remove sessions and switch" }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onConfirm).toHaveBeenCalledWith("/code/elsewhere")
  })
})
