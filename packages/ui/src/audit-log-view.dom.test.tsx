import { act, cleanup, render, screen, within } from "@testing-library/react"
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

function renderAudit(entries: AuditEntry[], clientKind?: "desktop" | "web") {
  const current: AuditQueryPage = { entries, hasMore: false }
  return render(
    <AuditLogView
      connected
      initialPage={current}
      {...(clientKind ? { clientKind } : {})}
      onOpenSkills={vi.fn()}
      onQuery={vi.fn(async () => current)}
      onExport={vi.fn()}
    />,
  )
}

it("draws each row as the design's columns: time, action with actor, detail, who and outcome", async () => {
  const today = new Date()
  today.setHours(14, 7, 12, 0)
  renderAudit([{ ...entry, occurredAt: today.toISOString() }])
  await settle()

  const row = screen.getByRole("article")
  const time = row.querySelector("time")
  expect(time?.getAttribute("dateTime")).toBe(today.toISOString())
  expect(time?.textContent).toBe("14:07:12")
  expect(within(row).getByText("session.send")).toBeTruthy()
  expect(within(row).getByText("client")).toBeTruthy()
  expect(within(row).getByText("request completed").tagName).not.toBe("PRE")
  expect(within(row).getByText("desktop · desktop-1")).toBeTruthy()
  expect(within(row).getByText("succeeded")).toBeTruthy()
  expect(within(row).getByText("target · project-domovoi")).toBeTruthy()
  expect(within(row).getByText("session · session-111111111111")).toBeTruthy()
  expect(row.querySelector("pre")).toBeNull()
})

it("dates a row that was not recorded today", async () => {
  renderAudit([{ ...entry, occurredAt: new Date(2025, 7, 29, 9, 5, 3).toISOString() }])
  await settle()

  const time = screen.getByRole("article").querySelector("time")
  expect(time?.textContent).toContain("09:05:03")
  expect(time?.textContent).toContain("2025")
})

it("states the daemon's retention counts and draws no shield icons in the facts", async () => {
  renderAudit([entry])
  await settle()

  const facts = screen.getByRole("region", { name: "WHAT THIS LOG IS, AND IS NOT" })
  expect(within(facts).getByText("Retention is by count: 10,000 activity and 1,000 pre-authentication entries.")).toBeTruthy()
  expect(within(facts).getByText("Export writes a redacted file here. Moving it is your decision.")).toBeTruthy()
  expect(within(facts).queryByText(/local audit policy/)).toBeNull()
  expect(facts.querySelector("svg")).toBeNull()
})

it("says where the export lands for the client kind", async () => {
  renderAudit([entry], "web")
  await settle()
  expect(screen.getByText("saves to this device · 1 row loaded")).toBeTruthy()
  cleanup()

  renderAudit([entry, older], "desktop")
  await settle()
  expect(screen.getByText("writes a file on this machine · 2 rows loaded")).toBeTruthy()
  cleanup()

  renderAudit([entry])
  await settle()
  expect(screen.getByText("writes a file on this machine · 1 row loaded")).toBeTruthy()
})
