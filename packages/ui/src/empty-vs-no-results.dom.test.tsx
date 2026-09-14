import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"

import type { AuditQueryPage, SessionHistoryPage } from "@getdomovoi/protocol"

import { AuditLogView } from "./audit-log-view"
import { HistoryPanel } from "./workspace-shell"

afterEach(cleanup)

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

const emptyAudit: AuditQueryPage = { entries: [], hasMore: false }
const emptyHistory: SessionHistoryPage = { sessionId: "session-billing", items: [], hasMore: false }

// Not-searched and no-results are different answers, and the copy is where the
// difference has to land: telling someone to change a filter they never set
// does not merely fail to distinguish the two, it hands them the one
// instruction that cannot help.
it("says an unfiltered audit log is empty rather than unmatched", async () => {
  render(<AuditLogView connected initialPage={emptyAudit} onQuery={vi.fn(async () => emptyAudit)} onExport={vi.fn()} onOpenSkills={vi.fn()} />)
  await settle()

  expect(screen.getByText("This machine has recorded nothing yet")).toBeTruthy()
  expect(screen.queryByText(/Change search terms/)).toBeNull()
})

it("says a filtered audit log matched nothing, and names the filters to change", async () => {
  const user = userEvent.setup()
  render(<AuditLogView connected initialPage={emptyAudit} onQuery={vi.fn(async () => emptyAudit)} onExport={vi.fn()} onOpenSkills={vi.fn()} />)
  await settle()

  await user.type(screen.getByPlaceholderText("Actor, target, action, or redacted detail"), "prisma")
  await settle()

  expect(screen.getByText("No matching audit entries")).toBeTruthy()
  expect(screen.getByText(/Change search terms/)).toBeTruthy()
})

// The same pair on the other surface that collapsed it. A session before its
// first turn has no history, and every category is already selected.
it("says a new session has no history rather than no matching history", async () => {
  render(
    <HistoryPanel
      sessionId="session-billing"
      connected
      onLoad={vi.fn(async () => emptyHistory)}
    />,
  )
  await settle()

  expect(screen.getByText("Nothing has happened in this session yet")).toBeTruthy()
  expect(screen.queryByText(/Change filters or search terms/)).toBeNull()
})

it("says no matching history once a category has been turned off", async () => {
  const user = userEvent.setup()
  render(
    <HistoryPanel
      sessionId="session-billing"
      connected
      onLoad={vi.fn(async () => emptyHistory)}
    />,
  )
  await settle()

  await user.click(screen.getByRole("button", { name: "Tools" }))
  await settle()

  expect(screen.getByText("No matching history")).toBeTruthy()
  expect(screen.getByText(/Change filters or search terms/)).toBeTruthy()
})
