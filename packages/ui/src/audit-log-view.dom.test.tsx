import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import type { AuditEntry, AuditQueryPage, AuditQueryParams } from "@getdomovoi/protocol"

import { AuditLogView } from "./audit-log-view"

const entry: AuditEntry = {
  id: "audit-111111111111",
  occurredAt: "2026-08-29T18:30:00.000Z",
  actor: { kind: "client", client: "desktop", clientId: "desktop-1" },
  action: "session.send",
  outcome: "succeeded",
  sessionId: "session-111111111111",
  target: "project-domovoi",
  detail: "request completed",
}

const older: AuditEntry = { ...entry, id: "audit-222222222222", action: "session.archive" }

const page: AuditQueryPage = { entries: [entry], hasMore: true, nextCursor: entry.id }

const settle = () => act(async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it("matches the v2 audit surface contract", async () => {
  render(
    <AuditLogView
      connected
      initialPage={page}
      onOpenSkills={vi.fn()}
      onQuery={vi.fn(async () => page)}
      onExport={vi.fn()}
    />,
  )
  await settle()

  expect(screen.getByRole("heading", { name: "Audit log" })).toBeTruthy()
  expect(screen.getByText("Every decision this machine recorded, across every session.", { exact: false })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Export this query" })).toBeTruthy()
  expect(screen.getByText("WHAT THIS LOG IS, AND IS NOT")).toBeTruthy()
  expect(screen.queryByRole("complementary", { name: "Settings navigation" })).toBeNull()
})

it("filters the audit log by signed actor groups", async () => {
  const onQuery = vi.fn(async () => page)
  render(
    <AuditLogView
      connected
      initialPage={page}
      onOpenSkills={vi.fn()}
      onQuery={onQuery}
      onExport={vi.fn()}
    />,
  )
  await settle()

  await act(async () => {
    screen.getByRole("radio", { name: "Providers" }).click()
  })
  await settle()

  expect(onQuery).toHaveBeenLastCalledWith(
    expect.objectContaining({ actor: "provider", limit: 50 }),
    expect.anything(),
  )
  expect(screen.getByRole("radio", { name: "Providers" }).getAttribute("data-state")).toBe("on")
})

it("stops the clock on an older-entries query once it settles", async () => {
  const onQuery = vi.fn(async (params: AuditQueryParams): Promise<AuditQueryPage> => params.before
    ? { entries: [older], hasMore: false }
    : page)
  render(
    <AuditLogView
      connected
      initialPage={page}
      onOpenSkills={vi.fn()}
      onQuery={onQuery}
      onExport={vi.fn()}
    />,
  )
  await settle()
  expect(vi.getTimerCount()).toBe(0)

  await act(async () => {
    screen.getByRole("button", { name: "Load older" }).click()
  })
  await settle()

  expect(onQuery).toHaveBeenLastCalledWith(
    expect.objectContaining({ before: entry.id }),
    expect.objectContaining({ deadline: expect.anything() }),
  )
  expect(screen.getByText("session.archive")).toBeTruthy()
  expect(vi.getTimerCount()).toBe(0)
})
