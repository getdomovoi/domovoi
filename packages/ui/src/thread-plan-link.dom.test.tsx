import { demoWorkspace, type ThreadItem, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import { Thread } from "./thread"

afterEach(cleanup)

const handlers = {
  onQueuedChange: vi.fn(),
  onResolve: vi.fn(async () => {}),
  onSetRuntime: vi.fn(async () => {}),
  onForkSession: vi.fn(async () => {}),
  onListModels: vi.fn(async () => []),
  onNewSession: vi.fn(),
  onSend: vi.fn(async () => {}),
  onCheckpoint: vi.fn(async () => {}),
  onRestoreCheckpoint: vi.fn(async () => {}),
  onPauseSession: vi.fn(async () => {}),
}

const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
const clockAt = (iso: string) => hm.format(new Date(iso))

// D6, Desktop V2 conversation.plan-link: under the prose, Wrote a N step plan,
// when, and Read it, which opens the Plan preview. Built from the session's
// working plan; the plan names no message, so it sits after the last thing
// said at or before the plan was written.
function planned(plan: Partial<WorkspaceSnapshot["workingPlans"][number]> = {}): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const sessionId = snapshot.activeSessionId!
  const say = (id: string, kind: "user" | "assistant", body: string, createdAt: string): ThreadItem => ({ id, sessionId, kind, body, createdAt })
  snapshot.thread = [
    say("user-1", "user", "Fix the webhooks.", "2026-09-08T14:02:00.000Z"),
    say("assistant-1", "assistant", "Here is the plan.", "2026-09-08T14:02:40.000Z"),
    say("assistant-2", "assistant", "Applying the migration.", "2026-09-08T14:05:00.000Z"),
  ]
  const base = snapshot.workingPlans.find((candidate) => candidate.sessionId === sessionId)!
  snapshot.workingPlans = [{ ...base, structureRevision: 1, createdAt: "2026-09-08T14:03:00.000Z", updatedAt: "2026-09-08T14:06:00.000Z", ...plan }]
  return snapshot
}

const proseOrder = () => [...document.querySelectorAll("[data-assistant-prose], [data-plan-link]")]
  .map((element) => element.hasAttribute("data-plan-link") ? "plan" : element.textContent)

it("says how many steps the plan has and when it was written", () => {
  render(<Thread snapshot={planned()} connected queued={undefined} {...handlers} onOpenPlanPreview={vi.fn()} />)
  expect(screen.getByText("Wrote a 4 step plan")).toBeTruthy()
  expect(screen.getByText(clockAt("2026-09-08T14:03:00.000Z"))).toBeTruthy()
})

it("sits after the last prose written before the plan", () => {
  render(<Thread snapshot={planned()} connected queued={undefined} {...handlers} onOpenPlanPreview={vi.fn()} />)
  expect(proseOrder()).toEqual(["Here is the plan.", "plan", "Applying the migration."])
})

it("opens the Plan preview from Read it", async () => {
  const onOpenPlanPreview = vi.fn()
  render(<Thread snapshot={planned()} connected queued={undefined} {...handlers} onOpenPlanPreview={onOpenPlanPreview} />)
  await userEvent.setup().click(screen.getByRole("button", { name: /^Read it/u }))
  expect(onOpenPlanPreview).toHaveBeenCalledTimes(1)
})

// The plan's own times cannot say when it was revised: updatedAt also moves
// when a step's status changes. A revised plan says so without a time.
it("says revised, with no time, once the plan's steps were rewritten", () => {
  render(<Thread snapshot={planned({ structureRevision: 3 })} connected queued={undefined} {...handlers} onOpenPlanPreview={vi.fn()} />)
  expect(screen.getByText(`${clockAt("2026-09-08T14:03:00.000Z")} · revised`)).toBeTruthy()
  expect(screen.queryByText(new RegExp(clockAt("2026-09-08T14:06:00.000Z"), "u"))).toBeNull()
})

it("draws no row for a plan with no steps", () => {
  render(<Thread snapshot={planned({ steps: [], structureRevision: 0 })} connected queued={undefined} {...handlers} onOpenPlanPreview={vi.fn()} />)
  expect(screen.queryByText(/Wrote a/u)).toBeNull()
})

it("draws no Read it where nothing can open the preview", () => {
  render(<Thread snapshot={planned()} connected queued={undefined} {...handlers} />)
  expect(screen.getByText("Wrote a 4 step plan")).toBeTruthy()
  expect(screen.queryByRole("button", { name: /^Read it/u })).toBeNull()
})
