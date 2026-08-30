import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { AuditEntry, AuditQueryPage } from "@getdomovoi/protocol"

import { AuditLogView, auditActorLabel, auditExportFilename } from "./audit-log-view"

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

const page: AuditQueryPage = {
  entries: [entry],
  hasMore: true,
  nextCursor: entry.id,
}

describe("audit log view", () => {
  it("renders redacted audit facts in the signed settings surface", () => {
    const markup = renderToStaticMarkup(
      <AuditLogView
        connected
        initialPage={page}
        onBack={vi.fn()}
        onOpenSkills={vi.fn()}
        onQuery={vi.fn(async () => page)}
        onExport={vi.fn()}
      />,
    )

    expect(markup).toContain("Audit log")
    expect(markup).toContain("session.send")
    expect(markup).toContain("desktop · desktop-1")
    expect(markup).toContain("request completed")
    expect(markup).toContain("Load older")
    expect(markup).toContain("Export JSONL")
  })

  it("labels every typed actor without leaking object serialization", () => {
    expect(auditActorLabel(entry.actor)).toBe("desktop · desktop-1")
    expect(auditActorLabel({ kind: "provider", provider: "codex", providerThreadId: "thread-1" }))
      .toBe("codex · thread-1")
    expect(auditActorLabel({ kind: "daemon", component: "rpc" })).toBe("daemon · rpc")
  })

  it("builds a filesystem-safe deterministic export name", () => {
    expect(auditExportFilename("2026-08-29T18:30:00.000Z")).toBe(
      "domovoi-audit-2026-08-29T18-30-00-000Z.jsonl",
    )
  })
})
