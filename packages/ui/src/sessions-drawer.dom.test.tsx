import { demoWorkspace, type WorkspaceSnapshot } from "@getdomovoi/protocol"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"

import { SessionsDrawer } from "./sessions-drawer"

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
  expect(screen.getByText("running")).toBeTruthy()
  expect(screen.getByText("failed")).toBeTruthy()
  expect(screen.getByText("idle")).toBeTruthy()
})

it("activates a session and closes itself", async () => {
  const user = userEvent.setup()
  const onActivate = vi.fn()
  render(<Harness onActivate={onActivate} />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  await user.click(screen.getByRole("button", { name: /Port the CLI auth flow/ }))
  expect(onActivate).toHaveBeenCalledWith("s2")
  expect(screen.queryByText("Port the CLI auth flow")).toBeNull()
})

it("closes on Escape without activating anything", async () => {
  const user = userEvent.setup()
  const onActivate = vi.fn()
  render(<Harness onActivate={onActivate} />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("region", { name: "RUNNING" })).toBeNull()
  expect(onActivate).not.toHaveBeenCalled()
})

it("keeps its actions reachable when the list is long", async () => {
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
    return <SessionsDrawer snapshot={snapshot} open={open} onOpenChange={setOpen} onActivate={vi.fn()} onNewSession={vi.fn()} />
  }
  render(<Long />)
  await user.click(screen.getByRole("button", { name: /Sessions/ }))

  // Measured in a real browser at 1280x800: 43 sessions rendered 2440px tall
  // with no cap and no scroll, putting New session 1679px below the fold.
  const surface = screen.getByRole("group", { name: "Sessions" })
  expect(surface.className).toContain("max-h-[70vh]")
  const scroller = surface.querySelector(".overflow-y-auto")
  expect(scroller).not.toBeNull()
  const action = screen.getByRole("button", { name: "New session" })
  expect(scroller!.contains(action)).toBe(false)
})

it("closes again when its own trigger is clicked", async () => {
  const user = userEvent.setup()
  render(<Harness onActivate={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: /^Sessions / }))
  expect(screen.getByRole("group", { name: "Sessions" })).toBeTruthy()
  await user.click(screen.getByRole("button", { name: /^Hide sessions / }))
  expect(screen.queryByRole("group", { name: "Sessions" })).toBeNull()
})

it("says which session is open, without leaving it to the background colour", async () => {
  const user = userEvent.setup()
  render(<Harness onActivate={vi.fn()} />)
  await user.click(screen.getByRole("button", { name: /^Sessions / }))
  expect(screen.getByRole("button", { name: /Migrate billing webhooks/ }).getAttribute("aria-current")).toBe("true")
  expect(screen.getByRole("button", { name: /Port the CLI auth flow/ }).getAttribute("aria-current")).toBeNull()
})
