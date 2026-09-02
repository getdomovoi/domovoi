import { useState } from "react"
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

function RetryHarness({ retry }: { retry: Promise<void> }) {
  const [open, setOpen] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")

  return open ? (
    <ProjectSwitchConfirmationDialog
      confirmation={confirmation}
      pending={pending}
      error={error}
      onCancel={() => setOpen(false)}
      onConfirm={async () => {
        setPending(true)
        try {
          await retry
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Project switch failed")
        } finally {
          setPending(false)
        }
      }}
    />
  ) : null
}

describe("ProjectSwitchConfirmationDialog", () => {
  it("names the preserved state and the stopped work, and cancels without retry", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(<ProjectSwitchConfirmationDialog confirmation={confirmation} onCancel={onCancel} onConfirm={onConfirm} />)

    expect(screen.getByText(/keeps 2 sessions and their saved history/i)).not.toBeNull()
    expect(screen.getByText(/1 isolated worktree/i)).not.toBeNull()
    expect(screen.getByText(/restores them when you reopen this project/i)).not.toBeNull()
    expect(screen.getByText(/stops any turn, provider thread, and terminal that is still running/i)).not.toBeNull()
    expect(screen.queryByText(/removes/i)).toBeNull()
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

    await user.click(screen.getByRole("button", { name: "Stop work and switch" }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onConfirm).toHaveBeenCalledWith("/code/elsewhere")
  })

  it("stays open while retrying and shows a failed retry", async () => {
    const user = userEvent.setup()
    let rejectRetry: (cause: Error) => void = () => undefined
    const retry = new Promise<void>((_resolve, reject) => {
      rejectRetry = reject
    })

    render(<RetryHarness retry={retry} />)
    await user.click(screen.getByRole("button", { name: "Stop work and switch" }))
    rejectRetry(new Error("Project switch retry failed"))

    expect((await screen.findByRole("alert")).textContent).toContain("Project switch retry failed")
    expect(screen.getByRole("alertdialog")).not.toBeNull()
  })

  it("disables cancellation and confirmation while retrying", async () => {
    const user = userEvent.setup()
    render(<RetryHarness retry={new Promise(() => undefined)} />)

    await user.click(screen.getByRole("button", { name: "Stop work and switch" }))

    expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Keep current project" })).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Switching…" }).disabled).toBe(true)
  })
})
