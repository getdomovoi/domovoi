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

// The daemon pages history oldest first, so the session-start checkpoint comes
// first here and the panel has to turn the page round. The session start is the
// only row that offers Reset instead of Revert, and no Fork.
function page(overrides: Partial<SessionHistoryPage> = {}): SessionHistoryPage {
  return {
    sessionId: "session-billing",
    hasMore: false,
    items: [
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
    ],
    ...overrides,
  }
}

function recovery(): SessionHistoryPage["items"][number] {
  return {
    id: "thread:ckpt-9c01",
    sourceId: "ckpt-9c01",
    sessionId: "session-billing",
    createdAt: "2026-09-08T14:09:00.000Z",
    category: "checkpoints",
    reason: "before-restore",
    label: "Before restore",
    commit: "c".repeat(40),
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

it("loads older checkpoints below the page and keeps the session start reachable", async () => {
  const older = page({ hasMore: false })
  const latest = page({
    hasMore: true,
    nextCursor: "thread:ckpt-7f24",
    items: [page().items[1]!, recovery()],
  })
  const onLoad = vi.fn(async (_sessionId: string, options?: { before?: string }) => options?.before ? older : latest)
  render(panel(onLoad as unknown as Load))
  await settle()
  expect(screen.getAllByTestId("checkpoint-row").map((row) => within(row).getByTestId("checkpoint-meta").textContent))
    .toEqual(["14:09 · before a restore", "14:06 · manual"])

  await userEvent.setup().click(screen.getByRole("button", { name: "Load older" }))
  await settle()
  expect(onLoad).toHaveBeenLastCalledWith(
    "session-billing",
    expect.objectContaining({ categories: ["checkpoints"], before: "thread:ckpt-7f24" }),
    expect.anything(),
  )
  const rows = screen.getAllByTestId("checkpoint-row")
  expect(rows.map((row) => within(row).getByTestId("checkpoint-meta").textContent))
    .toEqual(["14:09 · before a restore", "14:06 · manual", "14:02 · session start"])
  expect(within(rows[2]!).getByRole("button", { name: "Reset" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Load older" })).toBeNull()
})

it("reloads when the session records a new checkpoint while the tab is open", async () => {
  let items = page().items
  const onLoad = vi.fn(async () => page({ items }))
  const view = render(panel(onLoad, { revision: "thread:ckpt-7f24" }))
  await settle()
  expect(screen.getAllByTestId("checkpoint-row")).toHaveLength(2)

  items = [...items, recovery()]
  view.rerender(panel(onLoad, { revision: "thread:ckpt-9c01" }))
  await settle()
  expect(onLoad).toHaveBeenCalledTimes(2)
  const rows = screen.getAllByTestId("checkpoint-row")
  expect(rows).toHaveLength(3)
  expect(within(rows[0]!).getByText("ckpt-9c01")).toBeTruthy()
})

it("names the newest checkpoint item the snapshot holds for the session", async () => {
  const { latestCheckpointRevision } = await import("./checkpoints-panel")
  const snapshot = {
    thread: [
      { id: "thread-1", sessionId: "session-billing", kind: "checkpoint" },
      { id: "thread-2", sessionId: "session-other", kind: "checkpoint" },
      { id: "thread-3", sessionId: "session-billing", kind: "user" },
    ],
  } as unknown as Parameters<typeof latestCheckpointRevision>[0]
  expect(latestCheckpointRevision(snapshot, "session-billing")).toBe("thread-1")
  expect(latestCheckpointRevision(snapshot, "session-none")).toBeUndefined()
  expect(latestCheckpointRevision(snapshot, null)).toBeUndefined()
})

// v2 puts Take a checkpoint at the head of the tab, with an optional label and
// a note saying what it commits, so the person does not go to the palette for it.
it("takes a labelled checkpoint from the head of the tab", async () => {
  const user = userEvent.setup()
  const onTakeCheckpoint = vi.fn(async () => {})
  render(panel(vi.fn(async () => page()), { onTakeCheckpoint }))
  await settle()
  await user.click(screen.getByRole("button", { name: "Take a checkpoint" }))
  expect(screen.getByText("Optional label. It commits the worktree as it is now, on the session branch, and reverts like the others.")).toBeTruthy()
  await user.type(screen.getByRole("textbox", { name: "Checkpoint label" }), "Before I shorten the claim expiry")
  await user.click(screen.getByRole("button", { name: "Take checkpoint" }))
  expect(onTakeCheckpoint).toHaveBeenCalledWith("Before I shorten the claim expiry")
  await settle()
  expect(screen.queryByRole("textbox", { name: "Checkpoint label" })).toBeNull()
})

it("takes an unlabelled checkpoint and keeps the form open when the daemon refuses", async () => {
  const user = userEvent.setup()
  const onTakeCheckpoint = vi.fn(async () => { throw new Error("The worktree is busy") })
  render(panel(vi.fn(async () => page()), { onTakeCheckpoint }))
  await settle()
  await user.click(screen.getByRole("button", { name: "Take a checkpoint" }))
  await user.click(screen.getByRole("button", { name: "Take checkpoint" }))
  expect(onTakeCheckpoint).toHaveBeenCalledWith(undefined)
  expect((await screen.findByRole("alert")).textContent).toContain("The worktree is busy")
  expect(screen.getByRole("textbox", { name: "Checkpoint label" })).toBeTruthy()
})

it("says why a checkpoint cannot be taken while a turn runs", async () => {
  render(panel(vi.fn(async () => page()), { onTakeCheckpoint: vi.fn(), takeBlockedReason: "Stop the active turn before creating a checkpoint" }))
  await settle()
  const take = screen.getByRole("button", { name: "Take a checkpoint" })
  expect(take.hasAttribute("disabled")).toBe(true)
  expect(screen.getByText("Stop the active turn before creating a checkpoint")).toBeTruthy()
})

it("offers no checkpoint to a client that cannot take one", async () => {
  render(panel(vi.fn(async () => page())))
  await settle()
  expect(screen.queryByRole("button", { name: "Take a checkpoint" })).toBeNull()
})

it("returns focus to Take a checkpoint when the form closes", async () => {
  const user = userEvent.setup()
  const onTakeCheckpoint = vi.fn(async () => {})
  render(panel(vi.fn(async () => page()), { onTakeCheckpoint }))
  await settle()
  const take = screen.getByRole("button", { name: "Take a checkpoint" })
  await user.click(take)
  await user.click(screen.getByRole("button", { name: "Cancel" }))
  expect(document.activeElement).toBe(take)
  await user.click(take)
  await user.click(screen.getByRole("button", { name: "Take checkpoint" }))
  await settle()
  expect(screen.queryByRole("textbox", { name: "Checkpoint label" })).toBeNull()
  expect(document.activeElement).toBe(take)
})
