import { demoWorkspace, type ProviderModel, type Runtime, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./thread"

afterEach(cleanup)

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const models: ProviderModel[] = [{
  provider: "claude-code",
  id: "sonnet-4.6",
  displayName: "sonnet-4.6",
  description: "",
  supportedReasoningEfforts: ["low", "medium", "high", "max"],
  defaultReasoningEffort: "high",
  isDefault: true,
}]

function workspace(activeTurnId: string | undefined, reasoning = "high"): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.machine.providers = [{ id: "claude-code", command: "claude", status: "ready", sessionCapable: true }]
  const session = snapshot.sessions.find((candidate) => candidate.id === snapshot.activeSessionId)!
  session.state = "active"
  session.runtime = { ...session.runtime, reasoning }
  if (activeTurnId) session.activeTurnId = activeTurnId
  snapshot.thread = []
  return snapshot
}

function thread(snapshot: WorkspaceSnapshot, onSetRuntime: (runtime: Runtime) => Promise<void>) {
  return (
    <Thread
      snapshot={snapshot}
      connected
      queued={undefined}
      onQueuedChange={vi.fn()}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={onSetRuntime}
      onForkSession={vi.fn(async () => {})}
      onListModels={vi.fn(async () => models)}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />
  )
}

async function pickEffort(effort: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  await user.click(within(screen.getByRole("radiogroup", { name: "Reasoning effort" })).getByRole("radio", { name: effort }))
  await settle()
}

// The daemon stores a new effort at once and hands it to the provider with the
// next send, so a turn already running keeps the effort it started with. The
// composer says the change is waiting until that turn ends.
it("says a new effort waits for the next turn while one is running, and drops the note when it ends", async () => {
  const onSetRuntime = vi.fn(async () => {})
  const view = render(thread(workspace("turn-1"), onSetRuntime))
  await pickEffort("max")
  expect(onSetRuntime).toHaveBeenCalledWith(expect.objectContaining({ reasoning: "max" }))
  view.rerender(thread(workspace("turn-1", "max"), onSetRuntime))
  expect(screen.getByRole("status", { name: "Reasoning change waiting" }).textContent).toBe("reasoning max from the next turn")
  view.rerender(thread(workspace(undefined, "max"), onSetRuntime))
  expect(screen.queryByRole("status", { name: "Reasoning change waiting" })).toBeNull()
})

it("draws no waiting note for a change made between turns, which the next send carries", async () => {
  const onSetRuntime = vi.fn(async () => {})
  const view = render(thread(workspace(undefined), onSetRuntime))
  await pickEffort("low")
  view.rerender(thread(workspace(undefined, "low"), onSetRuntime))
  expect(screen.queryByRole("status", { name: "Reasoning change waiting" })).toBeNull()
})

it("draws no waiting note when the daemon refuses the change", async () => {
  const onSetRuntime = vi.fn(async () => { throw new Error("Reasoning effort is not supported by the selected model") })
  render(thread(workspace("turn-1"), onSetRuntime))
  await pickEffort("max")
  expect(screen.queryByRole("status", { name: "Reasoning change waiting" })).toBeNull()
  expect(screen.getByText("Reasoning effort is not supported by the selected model")).toBeTruthy()
})
