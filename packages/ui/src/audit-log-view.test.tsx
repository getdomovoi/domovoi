import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { AuditEntry, AuditQueryPage } from "@getdomovoi/protocol"

import {
  AuditLogView,
  auditActorLabel,
  auditExportFilename,
  cancelAuditExport,
  collectAuditExport,
  downloadAuditExport,
} from "./audit-log-view"

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
    expect(markup.match(/>Skills<\/button>/g)).toHaveLength(2)
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

  it("keeps the export blob alive until the browser handles the click", async () => {
    vi.useFakeTimers()
    const click = vi.fn()
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ click })),
    })
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audit-export")
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})

    downloadAuditExport({
      format: "jsonl",
      exportedAt: "2026-08-29T18:30:00.000Z",
      entryCount: 1,
      content: `${JSON.stringify(entry)}\n`,
    })

    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit-export")

    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("aborts and clears an active export controller", () => {
    const controller = new AbortController()
    const holder = { current: controller as AbortController | undefined }

    cancelAuditExport(holder)

    expect(controller.signal.aborted).toBe(true)
    expect(holder.current).toBeUndefined()
  })

  it("drains stable export cursors instead of silently downloading one page", async () => {
    const onExport = vi.fn()
      .mockResolvedValueOnce({
        format: "jsonl",
        exportedAt: "2026-08-29T18:30:00.000Z",
        entryCount: 1,
        content: `${JSON.stringify(entry)}\n`,
        hasMore: true,
        nextCursor: entry.id,
      })
      .mockResolvedValueOnce({
        format: "jsonl",
        exportedAt: "2026-08-29T18:29:00.000Z",
        entryCount: 1,
        content: `${JSON.stringify({ ...entry, id: "audit-222222222222" })}\n`,
        hasMore: false,
      })

    const exported = await collectAuditExport(onExport, { query: "session" }, {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 30_000,
    })

    expect(onExport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ before: entry.id, limit: 500 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(exported.entryCount).toBe(2)
    expect(exported.content.trimEnd().split("\n")).toHaveLength(2)
  })

  it("fails an unstable paginated export instead of producing a partial file", async () => {
    const onExport = vi.fn(async () => ({
      format: "jsonl" as const,
      exportedAt: "2026-08-29T18:30:00.000Z",
      entryCount: 1,
      content: `${JSON.stringify(entry)}\n`,
      hasMore: true,
      nextCursor: entry.id,
    }))

    await expect(collectAuditExport(onExport, {}, {
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 30_000,
    })).rejects.toThrow("repeated a continuation cursor")
  })
})
