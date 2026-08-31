import { demoWorkspace, providerFailureSchema } from "@getdomovoi/protocol"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Thread } from "./workspace-shell.js"

afterEach(cleanup)

const deferred = () => {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("provider restart interaction", () => {
  it("blocks duplicate clicks, reports failure, and permits retry", async () => {
    const snapshot = structuredClone(demoWorkspace)
    const active = snapshot.sessions.find(({ id }) => id === snapshot.activeSessionId)!
    active.state = "failed"
    delete active.providerThreadId
    active.providerFailure = providerFailureSchema.parse({
      kind: "transport",
      action: "retry",
      message: "Provider connection failed",
      retryable: true,
    })
    const first = deferred()
    const restart = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined)
    const thread = (current: typeof snapshot) => (
      <Thread
        snapshot={current}
        connected
        onResolve={vi.fn(async () => {})}
        onSetRuntime={vi.fn(async () => {})}
        onRestartProviderThread={restart}
        onForkSession={vi.fn(async () => {})}
        onListModels={vi.fn(async () => [])}
        onNewSession={vi.fn()}
        onSend={vi.fn(async () => {})}
        onCheckpoint={vi.fn(async () => {})}
        onRestoreCheckpoint={vi.fn(async () => {})}
        onPauseSession={vi.fn(async () => {})}
        onArchiveSession={vi.fn(async () => {})}
      />
    )
    const view = render(thread(snapshot))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Restart provider" }))
    const pending = screen.getByRole("button", { name: "Restarting provider…" }) as HTMLButtonElement
    expect(pending.disabled).toBe(true)
    await user.click(pending)
    expect(restart).toHaveBeenCalledTimes(1)

    first.reject(new Error("Provider login expired"))
    await screen.findByText("Provider login expired")
    await user.type(screen.getByLabelText("Message"), "Continue")
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole("button", { name: "Restart provider" }))
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(2))
    const recovered = structuredClone(snapshot)
    const recoveredSession = recovered.sessions.find(({ id }) => id === recovered.activeSessionId)!
    recoveredSession.state = "idle"
    recoveredSession.providerThreadId = "thread-restarted"
    delete recoveredSession.providerFailure
    view.rerender(thread(recovered))
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
