import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { ComposedSessionsDrawer as SessionsDrawer } from "./test-support/sessions-drawer"

afterEach(cleanup)

function snapshotWith(): WorkspaceSnapshot {
  const snapshot = structuredClone(demoWorkspace)
  const base = snapshot.sessions[0]!
  snapshot.sessions = [
    { ...base, id: "s1", title: "Migrate billing webhooks", activeTurnId: "turn-1", state: "active" },
    { ...base, id: "s2", title: "Port the CLI auth flow", state: "failed" },
    { ...base, id: "s3", title: "Document the replay table", state: "idle" },
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

it("says why each session is where it is, in words", async () => {
  const user = userEvent.setup()
  render(<Harness onActivate={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  expect(screen.getByText(/· running$/)).toBeTruthy()
  expect(screen.getByText(/· failed$/)).toBeTruthy()
  expect(screen.getByText(/· idle$/)).toBeTruthy()
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
  expect(screen.getByText(`${demoWorkspace.machine.name} · running`)).toBeTruthy()
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
  expect(screen.getByText(/· archived$/)).toBeTruthy()
  await user.click(screen.getByRole("button", { name: `Actions for ${archived.title}` }))
  const later = screen.getByRole("menuitem", { name: /Start a new session from this branch/ })
  expect(later.getAttribute("aria-disabled")).toBe("true")
  expect(later.textContent).toContain("later")
  expect(screen.getByText("Archived, so there is no worktree to delete. It cannot be forked, unarchived or sent to.")).toBeTruthy()
  for (const name of ["Archive session", "Fork from a checkpoint", "Move to another machine", "Resume session"]) {
    expect(screen.queryByRole("menuitem", { name })).toBeNull()
  }
})
