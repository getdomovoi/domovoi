import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { ComposedSessionsDrawer as SessionsDrawer } from "./test-support/sessions-drawer"

afterEach(cleanup)

const now = Date.parse("2026-10-11T12:00:00.000Z")
const ago = (ms: number) => new Date(now - ms).toISOString()
const minute = 60_000
const machine = demoWorkspace.machine.name

beforeEach(() => {
  // Only Date: the user-event timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(now)
})

afterEach(() => {
  vi.useRealTimers()
})

function snapshotWith(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const base = snapshot.sessions[0]!
  snapshot.sessions = [
    { ...base, id: "s1", title: "Migrate billing webhooks", activeTurnId: "turn-1", state: "active", updatedAt: ago(minute) },
    { ...base, id: "s2", title: "Port the CLI auth flow", state: "failed", updatedAt: ago(60 * minute) },
    { ...base, id: "s3", title: "Document the replay table", state: "idle", updatedAt: ago(2 * 24 * 60 * minute) },
  ]
  // The ledger's record of s1's turn in flight: an earlier finished turn and
  // the pending one, started twelve minutes ago.
  snapshot.turns = [
    { id: "a".repeat(64), sessionId: "s1", ordinal: 1, startedAt: ago(40 * minute), completedAt: ago(30 * minute), status: "completed" },
    { id: "b".repeat(64), sessionId: "s1", ordinal: 2, startedAt: ago(12 * minute), status: "pending" },
  ]
  delete (snapshot.sessions[1] as { activeTurnId?: string }).activeTurnId
  delete (snapshot.sessions[2] as { activeTurnId?: string }).activeTurnId
  snapshot.activeSessionId = "s1"
  snapshot.approvals = []
  return snapshot
}

function Harness({ onActivate }: { onActivate: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <SessionsDrawer snapshot={snapshotWith()} open={open} onOpenChange={setOpen} onActivate={onActivate} />
  )
}

it("keeps the list behind a button until it is asked for", () => {
  render(<Harness onActivate={vi.fn()} />)
  expect(screen.queryByText("Migrate billing webhooks")).toBeNull()
  expect(screen.getByRole("button", { name: /Sessions 3/ })).toBeTruthy()
})

it("groups by what each session wants from you", async () => {
  const user = userEvent.setup()
  render(<Harness onActivate={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  expect(screen.getByRole("region", { name: "RUNNING" })).toBeTruthy()
  expect(screen.getByRole("region", { name: "NEEDS YOU" })).toBeTruthy()
  expect(screen.getByRole("region", { name: "QUIET" })).toBeTruthy()
})

// The row's name is its title and then its meta: the machine, the state and
// how long it has held (Desktop v2 drawer.row, Q364 A).
const row = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) })
const meta = (title: string) => row(title).querySelector("[data-session-meta]")?.textContent

it("says why each session is where it is, in words, and for how long", async () => {
  const user = userEvent.setup()
  render(<Harness onActivate={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  expect(meta("Migrate billing webhooks")).toBe(`${machine} · running 12m`)
  expect(meta("Port the CLI auth flow")).toBe(`${machine} · failed 1h ago`)
  expect(meta("Document the replay table")).toBe(`${machine} · idle 2d`)
  expect(row("Port the CLI auth flow").getAttribute("aria-label")).toBeNull()
  expect(row("Port the CLI auth flow").textContent).toContain(`${machine} · failed 1h ago`)
})

// The ledger only times turns the snapshot's thread links. A running session
// whose turn it did not send says running and nothing it cannot back.
it("names a running session without a duration when no start was sent", async () => {
  const user = userEvent.setup()
  const snapshot = snapshotWith()
  snapshot.turns = []
  function Untimed() {
    const [open, setOpen] = useState(false)
    return <SessionsDrawer snapshot={snapshot} open={open} onOpenChange={setOpen} onActivate={vi.fn()} />
  }
  render(<Untimed />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  expect(meta("Migrate billing webhooks")).toBe(`${machine} · running`)
})

// The column is a long-lived view: its times move while it is open.
it("keeps the times current while the column is open", () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
  vi.setSystemTime(now)
  const snapshot = snapshotWith()
  snapshot.sessions[2]!.updatedAt = ago(20_000)
  render(<SessionsDrawer snapshot={snapshot} open onOpenChange={vi.fn()} onActivate={vi.fn()} />)
  expect(meta("Document the replay table")).toBe(`${machine} · idle <1m`)
  act(() => { vi.advanceTimersByTime(3 * 60 * minute) })
  expect(meta("Document the replay table")).toBe(`${machine} · idle 3h`)
  expect(meta("Migrate billing webhooks")).toBe(`${machine} · running 3h`)
})

it("dims quiet rows the way the design does", async () => {
  const user = userEvent.setup()
  render(<Harness onActivate={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  expect(row("Document the replay table").parentElement?.className).toContain("opacity-55")
  expect(row("Migrate billing webhooks").parentElement?.className).not.toContain("opacity-55")
})

// v2's drawer is a column beside the thread, not a popover: picking a session
// keeps it open, and only its own button closes it.
it("activates a session and stays open", async () => {
  const user = userEvent.setup()
  const onActivate = vi.fn()
  render(<Harness onActivate={onActivate} />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  await user.click(screen.getByRole("button", { name: /Port the CLI auth flow/ }))
  expect(onActivate).toHaveBeenCalledWith("s2")
  expect(screen.getByText("Port the CLI auth flow")).toBeTruthy()
})

it("names the machine beside each session's state", async () => {
  const user = userEvent.setup()
  render(<Harness onActivate={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  expect(meta("Migrate billing webhooks")?.startsWith(`${machine} · `)).toBe(true)
})

it("folds a group away and back, keeping its count on the header", async () => {
  const user = userEvent.setup()
  render(<Harness onActivate={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  const header = screen.getByRole("button", { name: /RUNNING/ })
  expect(header.textContent).toContain("1")
  await user.click(header)
  expect(screen.queryByText("Migrate billing webhooks")).toBeNull()
  expect(header.getAttribute("aria-expanded")).toBe("false")
  await user.click(header)
  expect(screen.getByText("Migrate billing webhooks")).toBeTruthy()
})

it("keeps supported row actions reachable, while offering stop only for a running turn", async () => {
  const user = userEvent.setup()
  const onAction = vi.fn()
  function WithActions() {
    const [open, setOpen] = useState(true)
    return <SessionsDrawer snapshot={snapshotWith()} open={open} onOpenChange={setOpen} onActivate={vi.fn()} onAction={onAction} />
  }
  render(<WithActions />)
  await user.click(screen.getByRole("button", { name: "Actions for Migrate billing webhooks" }))
  expect(screen.getByRole("menuitem", { name: "Stop the agent" })).toBeTruthy()
  expect(screen.getByRole("menuitem", { name: "Fork from a checkpoint" })).toBeTruthy()
  expect(screen.getByRole("menuitem", { name: "Move to another machine" })).toBeTruthy()
  expect(screen.getByRole("menuitem", { name: "Archive session" })).toBeTruthy()
  await user.click(screen.getByRole("menuitem", { name: "Stop the agent" }))
  expect(onAction).toHaveBeenCalledWith("stop", "s1")

  await user.click(screen.getByRole("button", { name: "Actions for Document the replay table" }))
  expect(screen.queryByRole("menuitem", { name: "Stop the agent" })).toBeNull()
  await user.click(screen.getByRole("menuitem", { name: "Resume session" }))
  expect(onAction).toHaveBeenCalledWith("resume", "s3")

  await user.click(screen.getByRole("button", { name: "Actions for Document the replay table" }))
  await user.click(screen.getByRole("menuitem", { name: "Archive session" }))
  expect(onAction).toHaveBeenCalledWith("archive", "s3")
})

it("keeps long session lists scrollable and reserves the drawer footer for machine availability", async () => {
  const user = userEvent.setup()
  const snapshot = structuredClone(demoWorkspace)
  const base = snapshot.sessions[0]!
  snapshot.sessions = Array.from({ length: 43 }, (_, index) => {
    const session = { ...base, id: `s${index}`, title: `Review session ${index}`, state: "idle" as const }
    delete (session as { activeTurnId?: string }).activeTurnId
    return session
  })
  snapshot.activeSessionId = "s0"
  snapshot.approvals = []

  function Long() {
    const [open, setOpen] = useState(false)
    return <SessionsDrawer snapshot={snapshot} open={open} onOpenChange={setOpen} onActivate={vi.fn()} machineAvailability="3 machines · 1 unreachable" />
  }
  render(<Long />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))

  const surface = screen.getByRole("complementary", { name: "Sessions" })
  expect(surface.querySelector(".overflow-y-auto")).not.toBeNull()
  expect(screen.queryByRole("button", { name: "New session" })).toBeNull()
  expect(screen.getByText(/machines.*unreachable/u)).toBeTruthy()
})

it("closes again when its own trigger is clicked", async () => {
  const user = userEvent.setup()
  render(<Harness onActivate={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: /^Sessions / }))
  expect(screen.getByRole("complementary", { name: "Sessions" })).toBeTruthy()
  await user.click(screen.getByRole("button", { name: /^Hide sessions / }))
  expect(screen.queryByRole("complementary", { name: "Sessions" })).toBeNull()
})

// Both sessions are idle and identical apart from their id, so nothing but
// activeSessionId can carry the mark. A fixture with differing states would
// pass on the difference rather than on the fix.
function twinSnapshot(activeSessionId: string): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const base = snapshot.sessions[0]!
  snapshot.sessions = [
    { ...base, id: "t1", title: "Rotate the signing keys", state: "idle" },
    { ...base, id: "t2", title: "Trim the audit retention", state: "idle" },
  ]
  for (const session of snapshot.sessions) delete (session as { activeTurnId?: string }).activeTurnId
  snapshot.activeSessionId = activeSessionId
  snapshot.approvals = []
  return snapshot
}

function Twins({ activeSessionId }: { activeSessionId: string }) {
  const [open, setOpen] = useState(false)
  return <SessionsDrawer snapshot={twinSnapshot(activeSessionId)} open={open} onOpenChange={setOpen} onActivate={vi.fn()} />
}

it("retains aria-current while leaving the active state to the drawer row", async () => {
  const user = userEvent.setup()
  const view = render(<Twins activeSessionId="t1" />)
  await user.click(screen.getByRole("button", { name: /^Sessions / }))

  const open = () => screen.getByRole("button", { name: /Rotate the signing keys/ })
  const other = () => screen.getByRole("button", { name: /Trim the audit retention/ })
  expect(open().getAttribute("aria-current")).toBe("true")
  expect(other().getAttribute("aria-current")).toBeNull()
  expect(open().textContent).not.toContain("Current")

  view.rerender(<Twins activeSessionId="t2" />)
  expect(other().getAttribute("aria-current")).toBe("true")
  expect(open().getAttribute("aria-current")).toBeNull()
  expect(other().textContent).not.toContain("Current")
})

// A browser tab over the tailnet reaches one machine and holds its credential
// for the tab only; the column says both where the design draws them.
it("names the tab's scope and credential when asked to", async () => {
  const user = userEvent.setup()
  function Scoped() {
    const [open, setOpen] = useState(false)
    return <SessionsDrawer snapshot={snapshotWith()} open={open} onOpenChange={setOpen} onActivate={vi.fn()} scope={{ machine: demoWorkspace.machine.name, note: "this machine only" }} credentialNote={{ label: "Paired for this tab", meta: "ends when it closes" }} />
  }
  render(<Scoped />)
  await user.click(screen.getByRole("button", { name: /^Sessions / }))
  const column = screen.getByRole("complementary", { name: "Sessions" })
  expect(within(column).getByText(demoWorkspace.machine.name)).toBeTruthy()
  expect(within(column).getByText("this machine only")).toBeTruthy()
  expect(within(column).getByText("Paired for this tab")).toBeTruthy()
  expect(within(column).getByText("ends when it closes")).toBeTruthy()
})

// I69: an archived session has no worktree, so its row offers none of the
// worktree actions and says why. The one way forward is drawn disabled.
it("gives an archived row a menu that says what archive did", async () => {
  const user = userEvent.setup()
  const snapshot = snapshotWith()
  const archived = snapshot.sessions[2]!
  Object.assign(archived, { state: "archived", archiveRequestedAt: "2026-09-23T13:59:00.000Z", archiveCheckpoint: "b".repeat(40), archivedAt: "2026-09-23T14:09:00.000Z" })
  function WithArchived() {
    const [open, setOpen] = useState(true)
    return <SessionsDrawer snapshot={snapshot} open={open} onOpenChange={setOpen} onActivate={vi.fn()} onAction={vi.fn()} />
  }
  render(<WithArchived />)
  expect(meta(archived.title)).toBe(`${machine} · archived`)
  await user.click(screen.getByRole("button", { name: `Actions for ${archived.title}` }))
  const later = screen.getByRole("menuitem", { name: /Start a new session from this branch/ })
  expect(later.getAttribute("aria-disabled")).toBe("true")
  expect(later.textContent).toContain("later")
  expect(screen.getByText("Archived, so there is no worktree to delete. It cannot be forked, unarchived or sent to.")).toBeTruthy()
  for (const name of ["Archive session", "Fork from a checkpoint", "Move to another machine", "Resume session"]) {
    expect(screen.queryByRole("menuitem", { name })).toBeNull()
  }
})

it("counts only live sessions on the drawer button", () => {
  const snapshot = snapshotWith()
  Object.assign(snapshot.sessions[2]!, { state: "archived", archivedAt: "2026-09-23T14:09:00.000Z" })
  render(<SessionsDrawer snapshot={snapshot} open={false} onOpenChange={vi.fn()} onActivate={vi.fn()} />)
  expect(screen.getByRole("button", { name: /^Sessions 2/ })).toBeTruthy()
})

it("ties the archived explanation to the disabled later item", async () => {
  const user = userEvent.setup()
  const snapshot = snapshotWith()
  const archived = snapshot.sessions[2]!
  Object.assign(archived, { state: "archived", archivedAt: "2026-09-23T14:09:00.000Z" })
  render(<SessionsDrawer snapshot={snapshot} open onOpenChange={vi.fn()} onActivate={vi.fn()} onAction={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: `Actions for ${archived.title}` }))
  const later = screen.getByRole("menuitem", { name: /Start a new session from this branch/ })
  const describedBy = later.getAttribute("aria-describedby")
  expect(describedBy).toBeTruthy()
  expect(document.getElementById(describedBy!)?.textContent).toBe("Archived, so there is no worktree to delete. It cannot be forked, unarchived or sent to.")
})
