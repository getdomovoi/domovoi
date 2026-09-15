import type { SessionHistoryPage } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { CheckpointsPanel } from "./checkpoints-panel"

afterEach(cleanup)

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

// Newest first, the way the design lists them; the session-start checkpoint is
// the oldest and the only one that offers Reset instead of Revert, and no Fork.
function page(): SessionHistoryPage {
  return {
    sessionId: "session-billing",
    hasMore: false,
    items: [
      {
        id: "thread:ckpt-7f24",
        sourceId: "ckpt-7f24",
        sessionId: "session-billing",
        createdAt: "2026-09-08T14:06:00.000Z",
        category: "checkpoints",
        reason: "manual",
        label: "Before the migration ran",
        commit: "a".repeat(40),
      },
      {
        id: "thread:ckpt-0000",
        sourceId: "ckpt-0000",
        sessionId: "session-billing",
        createdAt: "2026-09-08T14:02:00.000Z",
        category: "checkpoints",
        reason: "session-start",
        label: "Worktree created off main at 8f3c1de",
        commit: "b".repeat(40),
      },
    ],
  }
}

type Load = ComponentProps<typeof CheckpointsPanel>["onLoad"]

function panel(onLoad: Load, extra: Partial<ComponentProps<typeof CheckpointsPanel>> = {}) {
  return (
    <CheckpointsPanel
      sessionId="session-billing"
      connected
      onLoad={onLoad}
      onRestoreCheckpoint={vi.fn()}
      onForkCheckpoint={vi.fn()}
      {...extra}
    />
  )
}

it("asks for the checkpoints category only and lists them newest first", async () => {
  const onLoad = vi.fn(async () => page())
  render(panel(onLoad))
  await settle()
  expect(onLoad).toHaveBeenCalledWith(
    "session-billing",
    expect.objectContaining({ categories: ["checkpoints"] }),
    expect.anything(),
  )
  const rows = screen.getAllByTestId("checkpoint-row")
  expect(rows).toHaveLength(2)
  expect(within(rows[0]!).getByText("ckpt-7f24")).toBeTruthy()
  expect(within(rows[0]!).getByText("Before the migration ran")).toBeTruthy()
  expect(within(rows[0]!).getByTestId("checkpoint-meta").textContent).toBe("14:06 · manual")
  expect(within(rows[1]!).getByTestId("checkpoint-meta").textContent).toBe("14:02 · session start")
})

it("offers Fork and Revert on a checkpoint, and only Reset on the session start", async () => {
  const onRestoreCheckpoint = vi.fn()
  const onForkCheckpoint = vi.fn()
  render(panel(vi.fn(async () => page()), { onRestoreCheckpoint, onForkCheckpoint }))
  await settle()
  const [latest, start] = screen.getAllByTestId("checkpoint-row")
  expect(within(latest!).getByRole("button", { name: "Fork" })).toBeTruthy()
  expect(within(latest!).getByRole("button", { name: "Revert" })).toBeTruthy()
  expect(within(start!).queryByRole("button", { name: "Fork" })).toBeNull()
  expect(within(start!).getByRole("button", { name: "Reset" })).toBeTruthy()

  const user = userEvent.setup()
  await user.click(within(latest!).getByRole("button", { name: "Revert" }))
  await user.click(screen.getByRole("button", { name: "Restore worktree" }))
  expect(onRestoreCheckpoint).toHaveBeenCalledWith("ckpt-7f24")
})

it("says why there is nothing, and says when history could not be read", async () => {
  render(panel(vi.fn(async () => ({ sessionId: "session-billing", hasMore: false, items: [] }))))
  await settle()
  expect(screen.getByText("No checkpoints yet")).toBeTruthy()
  cleanup()
  render(panel(vi.fn(async () => { throw new Error("history offline") })))
  await settle()
  expect(screen.getByText("Checkpoints unavailable")).toBeTruthy()
  expect(screen.getByText("history offline")).toBeTruthy()
})

it("holds Revert and Fork shut while a restore is blocked", async () => {
  render(panel(vi.fn(async () => page()), { restoreBlocked: true }))
  await settle()
  const [latest] = screen.getAllByTestId("checkpoint-row")
  expect((within(latest!).getByRole("button", { name: "Revert" }) as HTMLButtonElement).disabled).toBe(true)
  expect((within(latest!).getByRole("button", { name: "Fork" }) as HTMLButtonElement).disabled).toBe(true)
})
