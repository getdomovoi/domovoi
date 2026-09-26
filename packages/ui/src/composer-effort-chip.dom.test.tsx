import { demoWorkspace, type ProviderModel, type Runtime, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./thread"

afterEach(cleanup)

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

function model(id: string, supportedReasoningEfforts: string[], defaultReasoningEffort: string): ProviderModel {
  return { provider: "claude-code", id, displayName: id, description: "", supportedReasoningEfforts, defaultReasoningEffort, isDefault: id === "sonnet-4.6" }
}

const models: ProviderModel[] = [
  model("sonnet-4.6", ["low", "medium", "high", "max"], "high"),
  model("claude-opus-4.2", ["low", "medium", "high"], "high"),
  model("claude-haiku-4.1", [], "medium"),
]

function workspace(runtime: Partial<Runtime> = {}): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  snapshot.machine.providers = [{ id: "claude-code", command: "claude", status: "ready", sessionCapable: true }]
  const session = snapshot.sessions.find((candidate) => candidate.id === snapshot.activeSessionId)!
  session.state = "active"
  session.runtime = { ...session.runtime, ...runtime }
  snapshot.thread = []
  return snapshot
}

function thread(
  snapshot: WorkspaceSnapshot,
  onSetRuntime: (runtime: Runtime) => Promise<void>,
  onListModels: (provider: string) => Promise<ProviderModel[]> = vi.fn(async () => models),
) {
  return (
    <Thread
      snapshot={snapshot}
      connected
      queued={undefined}
      onQueuedChange={vi.fn()}
      onResolve={vi.fn(async () => {})}
      onSetRuntime={onSetRuntime}
      onForkSession={vi.fn(async () => {})}
      onListModels={onListModels}
      onNewSession={vi.fn()}
      onSend={vi.fn(async () => {})}
      onCheckpoint={vi.fn(async () => {})}
      onRestoreCheckpoint={vi.fn(async () => {})}
      onPauseSession={vi.fn(async () => {})}
    />
  )
}

// The effort chip sits after the mode chip and offers what the session's
// model reports. A pick goes out as session.setRuntime, like the mode chip's.
it("draws the effort chip after the mode chip and sends a pick as the session's runtime", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn(async () => {})
  render(thread(workspace({ reasoning: "high" }), onSetRuntime))
  await settle()
  const mode = screen.getByRole("button", { name: /^Mode: Build/ })
  const effort = screen.getByRole("button", { name: "High" })
  expect(mode.compareDocumentPosition(effort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await user.click(effort)
  expect(screen.getByText("EFFORT ON CLAUDE-CODE")).toBeTruthy()
  await user.click(screen.getByRole("menuitemradio", { name: /^Max/ }))
  await settle()
  expect(onSetRuntime).toHaveBeenCalledWith(expect.objectContaining({ model: "sonnet-4.6", reasoning: "max" }))
})

it("draws no effort chip for a model that reports no efforts", async () => {
  render(thread(workspace({ model: "claude-haiku-4.1", reasoning: "medium" }), vi.fn(async () => {})))
  await settle()
  expect(screen.getByRole("button", { name: /^Mode: Build/ })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Medium" })).toBeNull()
})

// A model change that cannot carry the effort moves it to the new model's
// default, and the effort menu says so until a level is picked.
it("says the effort moved when a model change could not carry it, until a level is picked", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn(async () => {})
  const view = render(thread(workspace({ reasoning: "max" }), onSetRuntime))
  await settle()
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  await user.click(screen.getByRole("option", { name: "claude-opus-4.2, claude-code" }))
  await user.click(screen.getByRole("button", { name: "Switch here" }))
  await settle()
  expect(onSetRuntime).toHaveBeenLastCalledWith(expect.objectContaining({ model: "claude-opus-4.2", reasoning: "high" }))
  view.rerender(thread(workspace({ model: "claude-opus-4.2", reasoning: "high" }), onSetRuntime))
  await user.click(screen.getByRole("button", { name: "High" }))
  expect(screen.getByText("claude-code has no Max, so this moved to High when you changed model. It stays there.")).toBeTruthy()
  await user.click(screen.getByRole("menuitemradio", { name: /^Low/ }))
  await settle()
  view.rerender(thread(workspace({ model: "claude-opus-4.2", reasoning: "low" }), onSetRuntime))
  await user.click(screen.getByRole("button", { name: "Low" }))
  expect(screen.queryByText(/so this moved to/)).toBeNull()
  expect(screen.getByText("Applies from the next turn. A turn already in flight keeps the effort it started with.")).toBeTruthy()
})

// Effort is its own chip in v2, so the model menu carries no effort group.
it("keeps effort out of the model menu", async () => {
  const user = userEvent.setup()
  render(thread(workspace({ reasoning: "high" }), vi.fn(async () => {})))
  await settle()
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  expect(screen.queryByRole("radiogroup")).toBeNull()
  expect(screen.queryByText("REASONING")).toBeNull()
})

it("keeps the moved-effort note through a mode change", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn(async () => {})
  const view = render(thread(workspace({ reasoning: "max" }), onSetRuntime))
  await settle()
  await user.click(screen.getByRole("button", { name: /claude-code · sonnet 4\.6/ }))
  await settle()
  await user.click(screen.getByRole("option", { name: "claude-opus-4.2, claude-code" }))
  await user.click(screen.getByRole("button", { name: "Switch here" }))
  await settle()
  view.rerender(thread(workspace({ model: "claude-opus-4.2", reasoning: "high" }), onSetRuntime))
  await user.click(screen.getByRole("button", { name: /^Mode: Build/ }))
  await user.click(screen.getByRole("option", { name: "Plan" }))
  await settle()
  view.rerender(thread(workspace({ model: "claude-opus-4.2", reasoning: "high", permissionMode: "plan" }), onSetRuntime))
  await user.click(screen.getByRole("button", { name: "High" }))
  expect(screen.getByText("claude-code has no Max, so this moved to High when you changed model. It stays there.")).toBeTruthy()
})

// A model that reports no levels shows no chip, so its value was never on
// screen. Moving off it must not say that value was dropped.
it("says nothing moved when the previous model reported no levels", async () => {
  const user = userEvent.setup()
  const onSetRuntime = vi.fn(async () => {})
  const view = render(thread(workspace({ model: "claude-haiku-4.1", reasoning: "none" }), onSetRuntime))
  await settle()
  await user.click(screen.getByRole("button", { name: /claude-code · haiku 4\.1/ }))
  await settle()
  await user.click(screen.getByRole("option", { name: "claude-opus-4.2, claude-code" }))
  await user.click(screen.getByRole("button", { name: "Switch here" }))
  await settle()
  expect(onSetRuntime).toHaveBeenLastCalledWith(expect.objectContaining({ model: "claude-opus-4.2", reasoning: "high" }))
  view.rerender(thread(workspace({ model: "claude-opus-4.2", reasoning: "high" }), onSetRuntime))
  await user.click(screen.getByRole("button", { name: "High" }))
  expect(screen.queryByText(/so this moved to/)).toBeNull()
  expect(screen.getByText("Applies from the next turn. A turn already in flight keeps the effort it started with.")).toBeTruthy()
})

// No read, no chip: while the model list is being read, and after a read
// fails, the composer draws no effort chip rather than a guess.
it("draws no effort chip while the model list is still being read", async () => {
  render(thread(workspace({ reasoning: "high" }), vi.fn(async () => {}), vi.fn(() => new Promise<ProviderModel[]>(() => {}))))
  await settle()
  expect(screen.getByRole("button", { name: /^Mode: Build/ })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "High" })).toBeNull()
})

it("drops the effort chip when a read of the model list fails", async () => {
  const onSetRuntime = vi.fn(async () => {})
  const view = render(thread(workspace({ reasoning: "high" }), onSetRuntime))
  await settle()
  expect(screen.getByRole("button", { name: "High" })).toBeTruthy()
  view.rerender(thread(workspace({ reasoning: "high" }), onSetRuntime, vi.fn(async () => { throw new Error("Daemon connection is not open") })))
  await settle()
  expect(screen.getByRole("button", { name: /^Mode: Build/ })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "High" })).toBeNull()
})
