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
