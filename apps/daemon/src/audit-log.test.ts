import { mkdtemp } from "node:fs/promises"
import { removeScratchDirectories } from "./test-scratch.js"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { SqliteAuditLog } from "./audit-log.js"

const scratchDirectories: string[] = []
afterEach(async () => removeScratchDirectories(scratchDirectories.splice(0)))

describe("SqliteAuditLog", () => {
  it("redacts secrets before durable storage and uses the same record for export", () => {
    const database = new DatabaseSync(":memory:")
    const audit = new SqliteAuditLog(database)

    const stored = audit.append({
      actor: {
        kind: "client",
        client: "desktop",
        clientId: "token=actor-secret",
        connectionId: "11111111-1111-4111-8111-111111111111",
      },
      action: "provider.configure secret=action-secret",
      outcome: "succeeded",
      sessionId: "session-1 password=session-secret",
      projectId: "project-1 token=project-secret",
      target: "https://user:target-secret@example.com",
      detail: "Authorization: Bearer top-secret-token api_key=sk-live-secret-value",
    })

    expect(stored.detail).toBe("Authorization: [REDACTED] api_key=[REDACTED]")
    expect(stored).toMatchObject({
      actor: {
        clientId: "token=[REDACTED]",
        connectionId: "11111111-1111-4111-8111-111111111111",
      },
      action: "provider.configure secret=[REDACTED]",
      sessionId: "session-1 password=[REDACTED]",
      projectId: "project-1 token=[REDACTED]",
      target: "https://[REDACTED]@example.com",
    })
    const raw = database.prepare("SELECT * FROM audit_log WHERE id = ?").get(stored.id)
    expect(raw).toMatchObject({
      actor_connection_id: "11111111-1111-4111-8111-111111111111",
    })
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

  it("holds exactly the retention bound after every append past it", () => {
    const database = new DatabaseSync(":memory:")
    const audit = new SqliteAuditLog(database, { maximumEntries: 5 })
    const storedRows = database.prepare("SELECT COUNT(*) AS count FROM audit_log")
    for (let index = 1; index <= 8; index += 1) {
      audit.append({
        id: `audit-${index}`,
        occurredAt: "2026-08-29T12:00:00.000Z",
        actor: { kind: "daemon", component: "workspace" },
        action: "workspace.get",
        outcome: "succeeded",
      })
      expect(storedRows.get()).toMatchObject({ count: Math.min(index, 5) })
    }

    expect(audit.query({ limit: 10 }).entries.map(({ id }) => id)).toEqual([
      "audit-8",
      "audit-7",
      "audit-6",
      "audit-5",
      "audit-4",
    ])
    database.close()
  })

  it("rejects unknown cursors instead of returning a misleading empty page", () => {
    const database = new DatabaseSync(":memory:")
    const audit = new SqliteAuditLog(database)
    audit.append({
      id: "audit-known",
      actor: { kind: "daemon", component: "server" },
      action: "workspace.get",
      outcome: "succeeded",
    })

    for (const operation of [
      () => audit.query({ before: "audit-missing", limit: 10 }),
      () => audit.export({ before: "audit-missing", limit: 10 }),
    ]) {
      try {
        operation()
        throw new Error("Expected an unknown audit cursor to fail")
      } catch (error) {
        expect(error).toMatchObject({ code: -32602, message: "Audit cursor does not exist" })
      }
    }
    database.close()
  })

  it("retains pre-auth refusals separately across a database restart", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "domovoi-audit-retention-"))
    scratchDirectories.push(scratch)
    const path = join(scratch, "state.sqlite")
    let database = new DatabaseSync(path)
    const audit = new SqliteAuditLog(database, {
      maximumEntries: 3,
      maximumPreAuthEntries: 2,
    })
    try {
      for (let index = 1; index <= 4; index += 1) {
        audit.append({
          id: `decision-${index}`,
          actor: { kind: "client", client: "desktop" },
          action: "approval.resolve",
          outcome: "denied",
        })
        for (let refusal = 0; refusal < 4; refusal += 1) {
          audit.append({
            id: `refusal-${index}-${refusal}`,
            retention: "pre-auth",
            actor: { kind: "daemon", component: "rpc" },
            action: "device.claim",
            outcome: "denied",
          })
        }
        expect(audit.query({ action: "approval.resolve" }).entries).toHaveLength(Math.min(index, 3))
        expect(audit.query({ action: "device.claim" }).entries).toHaveLength(2)
      }
      const expectedIds = ["refusal-4-3", "refusal-4-2", "decision-4", "decision-3", "decision-2"]
      expect(audit.query().entries.map(({ id }) => id)).toEqual(expectedIds)
      expect(audit.export().content.trim().split("\n").map((line) => JSON.parse(line).id))
        .toEqual(expectedIds)
      expect(audit.query({ before: "refusal-4-2" }).entries.map(({ id }) => id))
        .toEqual(expectedIds.slice(2))
      database.close()
      database = new DatabaseSync(path)
      const reopened = new SqliteAuditLog(database, { maximumEntries: 3, maximumPreAuthEntries: 2 })
      reopened.append({
        id: "refusal-after-reopen",
        retention: "pre-auth",
        actor: { kind: "daemon", component: "authentication" },
        action: "security.authentication",
        outcome: "denied",
      })
      expect(reopened.query({ action: "approval.resolve" }).entries.map(({ id }) => id))
        .toEqual(["decision-4", "decision-3", "decision-2"])
      expect(reopened.query().entries).toHaveLength(5)
      expect(reopened.export().content).not.toContain("retention")
    } finally {
      database.close()
    }
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

  it("adds retention isolation and connection attribution without deleting legacy history", () => {
    const database = new DatabaseSync(":memory:")
    database.exec(`
      CREATE TABLE audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_name TEXT,
        actor_reference TEXT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        session_id TEXT,
        project_id TEXT,
        target TEXT,
        detail TEXT
      )
    `)
    database.prepare(`
      INSERT INTO audit_log (id, occurred_at, actor_kind, actor_name, action, outcome)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("legacy-approval", "2026-08-29T12:00:00.000Z", "client", "desktop", "approval.resolve", "denied")
    const audit = new SqliteAuditLog(database, { maximumEntries: 2, maximumPreAuthEntries: 1 })
    audit.append({
      id: "audit-connection",
      actor: {
        kind: "client",
        client: "desktop",
        connectionId: "11111111-1111-4111-8111-111111111111",
      },
      action: "plan.edit",
      outcome: "succeeded",
    })

    expect(audit.query({ actor: "11111111-1111-4111-8111-111111111111" }).entries)
      .toEqual([expect.objectContaining({
        actor: expect.objectContaining({
          connectionId: "11111111-1111-4111-8111-111111111111",
        }),
      })])
    for (let index = 0; index < 4; index += 1) {
      audit.append({
        retention: "pre-auth",
        actor: { kind: "daemon", component: "rpc" },
        action: "device.claim",
        outcome: "denied",
      })
    }
    expect(audit.query().entries).toHaveLength(3)
    expect(audit.query({ action: "approval.resolve" }).entries)
      .toEqual([expect.objectContaining({ id: "legacy-approval" })])
    database.close()
  })
})
