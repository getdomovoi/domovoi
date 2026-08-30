import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { SqliteAuditLog } from "./audit-log.js"

const scratchDirectories: string[] = []
afterEach(async () => Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true }))))

describe("SqliteAuditLog", () => {
  it("redacts secrets before durable storage and uses the same record for export", () => {
    const database = new DatabaseSync(":memory:")
    const audit = new SqliteAuditLog(database)

    const stored = audit.append({
      actor: { kind: "client", client: "desktop", clientId: "token=actor-secret" },
      action: "provider.configure secret=action-secret",
      outcome: "succeeded",
      sessionId: "session-1 password=session-secret",
      projectId: "project-1 token=project-secret",
      target: "https://user:target-secret@example.com",
      detail: "Authorization: Bearer top-secret-token api_key=sk-live-secret-value",
    })

    expect(stored.detail).toBe("Authorization: [REDACTED] api_key=[REDACTED]")
    expect(stored).toMatchObject({
      actor: { clientId: "token=[REDACTED]" },
      action: "provider.configure secret=[REDACTED]",
      sessionId: "session-1 password=[REDACTED]",
      projectId: "project-1 token=[REDACTED]",
      target: "https://[REDACTED]@example.com",
    })
    const raw = database.prepare("SELECT * FROM audit_log WHERE id = ?").get(stored.id)
    expect(JSON.stringify(raw)).not.toContain("top-secret-token")
    expect(JSON.stringify(raw)).not.toContain("sk-live-secret-value")
    expect(JSON.stringify(raw)).not.toContain("actor-secret")
    expect(JSON.stringify(raw)).not.toContain("action-secret")
    expect(JSON.stringify(raw)).not.toContain("session-secret")
    expect(JSON.stringify(raw)).not.toContain("target-secret")
    expect(JSON.stringify(raw)).not.toContain("project-secret")
    const exported = audit.export({ limit: 100 })
    expect(exported.content).toContain("[REDACTED]")
    expect(exported.content).not.toContain("top-secret-token")
    expect(exported.content).not.toContain("sk-live-secret-value")
    expect(exported.content).not.toContain("actor-secret")
    expect(exported.content).not.toContain("action-secret")
    expect(exported.content).not.toContain("session-secret")
    expect(exported.content).not.toContain("target-secret")
    expect(exported.content).not.toContain("project-secret")

    database.close()
  })

  it("searches by text and structured filters with stable newest-first cursors", () => {
    const database = new DatabaseSync(":memory:")
    const audit = new SqliteAuditLog(database)
    audit.append({
      id: "audit-1",
      occurredAt: "2026-08-29T12:00:00.000Z",
      actor: { kind: "client", client: "desktop", clientId: "owner" },
      action: "terminal.input",
      outcome: "succeeded",
      sessionId: "session-a",
      projectId: "project-a",
      target: "terminal-a",
      detail: "ran pnpm test",
    })
    audit.append({
      id: "audit-2",
      occurredAt: "2026-08-29T12:00:00.000Z",
      actor: { kind: "client", client: "web", clientId: "reviewer" },
      action: "approval.resolve",
      outcome: "denied",
      sessionId: "session-b",
      projectId: "project-b",
      target: "approval-b",
      detail: "blocked deploy",
    })
    audit.append({
      id: "audit-3",
      occurredAt: "2026-08-29T12:00:00.000Z",
      actor: { kind: "client", client: "desktop", clientId: "owner" },
      action: "terminal.input",
      outcome: "failed",
      sessionId: "session-a",
      projectId: "project-a",
      target: "terminal-a",
      detail: "pnpm test failed",
    })

    expect(audit.query({ query: "pnpm", sessionId: "session-a", limit: 1 })).toEqual({
      entries: [expect.objectContaining({ id: "audit-3" })],
      hasMore: true,
      nextCursor: "audit-3",
    })
    expect(audit.query({ before: "audit-3", action: "terminal.input", limit: 10 })).toEqual({
      entries: [expect.objectContaining({ id: "audit-1" })],
      hasMore: false,
    })
    expect(audit.query({ actor: "web", outcome: "denied", limit: 10 }).entries).toEqual([
      expect.objectContaining({ id: "audit-2" }),
    ])
    expect(audit.query({ projectId: "project-a", limit: 10 }).entries.map(({ id }) => id)).toEqual([
      "audit-3",
      "audit-1",
    ])
    database.close()
  })

  it("prunes oldest rows to its configured retention bound", () => {
    const database = new DatabaseSync(":memory:")
    const audit = new SqliteAuditLog(database, { maximumEntries: 2 })
    for (let index = 1; index <= 3; index += 1) {
      audit.append({
        id: `audit-${index}`,
        occurredAt: `2026-08-29T12:0${index}:00.000Z`,
        actor: { kind: "daemon", component: "workspace" },
        action: "workspace.get",
        outcome: "succeeded",
      })
    }

    expect(audit.query({ limit: 10 }).entries.map(({ id }) => id)).toEqual(["audit-3", "audit-2"])
    database.close()
  })

  it("pages exports before their wire-size bound", () => {
    const database = new DatabaseSync(":memory:")
    const audit = new SqliteAuditLog(database)
    for (let index = 1; index <= 500; index += 1) {
      audit.append({
        id: `audit-${index}`,
        occurredAt: `2026-08-29T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
        actor: { kind: "provider", provider: "codex" },
        action: "terminal.output",
        outcome: "succeeded",
        detail: `${index}:${"x".repeat(4_090)}`,
      })
    }

    const exported = audit.export({ limit: 500 })
    expect(exported.content.length).toBeLessThanOrEqual(2_000_000)
    expect(exported.entryCount).toBeLessThan(500)
    expect(exported.hasMore).toBe(true)
    expect(exported.nextCursor).toBe(JSON.parse(exported.content.trimEnd().split("\n").at(-1)!).id)
    database.close()
  })

  it("bounds sanitized input, exports deterministically, and honors cancellation", () => {
    const database = new DatabaseSync(":memory:")
    const audit = new SqliteAuditLog(database)
    audit.append({
      id: `audit-${"i".repeat(600)}`,
      occurredAt: "2026-08-29T12:00:00.000Z",
      actor: { kind: "client", client: "desktop", clientId: `token=${"a".repeat(600)}` },
      action: `terminal.input ${"x".repeat(600)}`,
      outcome: "succeeded",
      projectId: `project-${"p".repeat(600)}`,
      detail: `secret=${"s".repeat(5_000)}`,
    })
    const first = audit.export({ limit: 10 })
    const second = audit.export({ limit: 10 })
    expect(second).toEqual(first)
    expect(first.exportedAt).toBe("2026-08-29T12:00:00.000Z")
    expect(first.content.length).toBeLessThanOrEqual(2_000_000)
    expect(first.content).not.toContain("s".repeat(100))
    const controller = new AbortController()
    controller.abort(new Error("cancel audit"))
    expect(() => audit.query({ limit: 10 }, controller.signal)).toThrow("cancel audit")
    expect(() => audit.export({ limit: 10 }, controller.signal)).toThrow("cancel audit")
    database.close()
  })

  it("persists redacted entries across a database restart", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-audit-restart-"))
    scratchDirectories.push(scratch)
    const path = join(scratch, "state.sqlite")
    let database = new DatabaseSync(path)
    new SqliteAuditLog(database).append({
      id: "audit-restart",
      occurredAt: "2026-08-29T12:00:00.000Z",
      actor: { kind: "daemon", component: "server" },
      action: "session.create",
      outcome: "succeeded",
      projectId: "project-restart",
      detail: "Authorization: Bearer restart-secret",
    })
    database.close()
    database = new DatabaseSync(path)
    const entries = new SqliteAuditLog(database).query({ projectId: "project-restart", limit: 10 }).entries
    expect(entries).toEqual([expect.objectContaining({ id: "audit-restart", detail: "Authorization: [REDACTED]" })])
    database.close()
  })
})
