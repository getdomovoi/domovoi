import { useEffect, useMemo, useRef, useState } from "react"
import {
  CircleStopIcon,
  DownloadIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react"

import type {
  AuditActor,
  AuditEntry,
  AuditExportParams,
  AuditExportResult,
  AuditOutcome,
  AuditQueryPage,
  AuditQueryParams,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { Field, FieldLabel } from "./components/ui/field"
import { Input } from "./components/ui/input"
import { ScrollArea } from "./components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"
import type { DomovoiRequestOptions } from "./client"
import { Deadline } from "./deadline"

const outcomes = ["all", "started", "succeeded", "failed", "denied", "cancelled"] as const
type OutcomeFilter = (typeof outcomes)[number]
const actors = [
  ["all", "Every actor"],
  ["client", "Clients"],
  ["daemon", "Daemon"],
  ["provider", "Providers"],
  ["machine", "Machines"],
] as const
type ActorFilter = (typeof actors)[number][0]
type AuditExportFilters = Omit<AuditExportParams, "before" | "format" | "limit">
type AuditDownload = Pick<AuditExportResult, "format" | "exportedAt" | "entryCount" | "content">
const auditQueryBudgetMs = 15_000
const auditExportBudgetMs = 60_000

type AbortControllerHolder = { current: AbortController | undefined }

const maximumAuditDownloadPages = 20
const maximumAuditDownloadBytes = 20_000_000

export function auditActorLabel(actor: AuditActor): string {
  if (actor.kind === "client") return [actor.client, actor.clientId].filter(Boolean).join(" · ")
  if (actor.kind === "provider") {
    return [actor.provider, actor.providerThreadId].filter(Boolean).join(" · ")
  }
  if (actor.kind === "machine") return ["machine", actor.machineId].join(" · ")
  return ["daemon", actor.component].filter(Boolean).join(" · ")
}

export function auditExportFilename(exportedAt: string): string {
  return `domovoi-audit-${exportedAt.replace(/[.:]/g, "-")}.jsonl`
}

export function downloadAuditExport(result: AuditDownload): void {
  const url = URL.createObjectURL(new Blob([result.content], { type: "application/x-ndjson" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = auditExportFilename(result.exportedAt)
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function cancelAuditExport(holder: AbortControllerHolder): void {
  const controller = holder.current
  holder.current = undefined
  controller?.abort(new DOMException("Audit export cancelled", "AbortError"))
}

export async function collectAuditExport(
  onExport: (params: AuditExportParams, options?: DomovoiRequestOptions) => Promise<AuditExportResult>,
  filters: AuditExportFilters,
  options: { signal: AbortSignal; budgetMs: number },
): Promise<AuditDownload> {
  // The export is one operation across every page it fetches, so the clock
  // starts here and is stopped here whatever way the export ends.
  const deadline = Deadline.start(options.budgetMs)
  try {
    return await collectAuditPages(onExport, filters, { signal: options.signal, deadline })
  } finally {
    deadline.clear()
  }
}

async function collectAuditPages(
  onExport: (params: AuditExportParams, options?: DomovoiRequestOptions) => Promise<AuditExportResult>,
  filters: AuditExportFilters,
  options: { signal: AbortSignal; deadline: Deadline },
): Promise<AuditDownload> {
  const chunks: string[] = []
  const cursors = new Set<string>()
  let entryCount = 0
  let byteCount = 0
  let before: string | undefined
  let exportedAt = "1970-01-01T00:00:00.000Z"

  for (let pageIndex = 0; pageIndex < maximumAuditDownloadPages; pageIndex += 1) {
    options.signal.throwIfAborted()
    if (options.deadline.expired) throw new Error("Audit export deadline exceeded")
    const page = await onExport(
      {
        ...filters,
        format: "jsonl",
        limit: 500,
        ...(before ? { before } : {}),
      },
      { signal: options.signal, deadline: options.deadline },
    )
    if (pageIndex === 0) exportedAt = page.exportedAt
    chunks.push(page.content)
    entryCount += page.entryCount
    byteCount += new TextEncoder().encode(page.content).byteLength
    if (byteCount > maximumAuditDownloadBytes) {
      throw new Error("Audit export exceeds the safe download limit; narrow the filters")
    }
    if (!page.hasMore) {
      return { format: "jsonl", exportedAt, entryCount, content: chunks.join("") }
    }
    if (!page.nextCursor) throw new Error("Audit export omitted its continuation cursor")
    if (cursors.has(page.nextCursor)) {
      throw new Error("Audit export repeated a continuation cursor")
    }
    cursors.add(page.nextCursor)
    before = page.nextCursor
  }

  throw new Error("Audit export exceeds the safe page limit; narrow the filters")
}

function outcomeVariant(outcome: AuditOutcome): "success" | "warning" | "destructive" | "outline" {
  if (outcome === "succeeded") return "success"
  if (outcome === "started") return "warning"
  if (outcome === "failed" || outcome === "denied") return "destructive"
  return "outline"
}

function mergeAuditPages(current: AuditQueryPage | undefined, older: AuditQueryPage): AuditQueryPage {
  if (!current) return older
  const known = new Set(current.entries.map(({ id }) => id))
  return {
    entries: [...current.entries, ...older.entries.filter(({ id }) => !known.has(id))],
    hasMore: older.hasMore,
    ...(older.nextCursor ? { nextCursor: older.nextCursor } : {}),
  }
}

function AuditEntryRow({ entry }: { entry: AuditEntry }) {
  return (
    <article className="flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-machine text-[11px] font-medium">{entry.action}</span>
        <Badge variant={outcomeVariant(entry.outcome)}>{entry.outcome}</Badge>
        <time className="ml-auto font-machine text-mono-xs text-faint" dateTime={entry.occurredAt}>
          {new Date(entry.occurredAt).toLocaleString()}
        </time>
      </div>
      <div className="flex flex-wrap gap-2 font-machine text-[9.5px] text-muted-foreground">
        <span>{auditActorLabel(entry.actor)}</span>
        {entry.sessionId ? <span>session · {entry.sessionId}</span> : null}
        {entry.target ? <span>target · {entry.target}</span> : null}
      </div>
      {entry.detail ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code p-2.5 font-machine text-[10px] leading-relaxed text-muted-foreground">
          {entry.detail}
        </pre>
      ) : null}
    </article>
  )
}

export function AuditLogView({
  connected,
  initialPage,
  onQuery,
  onExport,
}: {
  connected: boolean
  initialPage?: AuditQueryPage
  onOpenSkills: () => void
  onQuery: (params: AuditQueryParams, options?: DomovoiRequestOptions) => Promise<AuditQueryPage>
  onExport: (params: AuditExportParams, options?: DomovoiRequestOptions) => Promise<AuditExportResult>
}) {
  const [query, setQuery] = useState("")
  const [action, setAction] = useState("")
  const [outcome, setOutcome] = useState<OutcomeFilter>("all")
  const [actor, setActor] = useState<ActorFilter>("all")
  const [page, setPage] = useState<AuditQueryPage | undefined>(initialPage)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState("")
  const requestRef = useRef(0)
  const loadControllerRef = useRef<AbortController | undefined>(undefined)
  const exportControllerRef = useRef<AbortController | undefined>(undefined)
  const normalizedQuery = query.trim()
  const normalizedAction = action.trim()
  const filters = useMemo(() => ({
    ...(normalizedQuery ? { query: normalizedQuery } : {}),
    ...(normalizedAction ? { action: normalizedAction } : {}),
    ...(outcome !== "all" ? { outcome: outcome as AuditOutcome } : {}),
    ...(actor !== "all" ? { actor } : {}),
  }), [actor, normalizedAction, normalizedQuery, outcome])

  useEffect(() => {
    loadControllerRef.current?.abort()
    loadControllerRef.current = undefined
    if (!connected) {
      cancelAuditExport(exportControllerRef)
      setPage(undefined)
      setLoading(false)
      setError("Reconnect to the execution machine to read its audit log.")
      return
    }
    const request = ++requestRef.current
    const controller = new AbortController()
    const deadline = Deadline.start(auditQueryBudgetMs)
    setLoading(true)
    setError("")
    void onQuery({ ...filters, limit: 50 }, { signal: controller.signal, deadline }).then(
      (next) => { if (request === requestRef.current) setPage(next) },
      (cause: unknown) => {
        if (request === requestRef.current && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Audit log could not be loaded")
        }
      },
    ).finally(() => {
      deadline.clear()
      if (request === requestRef.current) setLoading(false)
    })
    return () => {
      controller.abort()
      loadControllerRef.current?.abort()
      loadControllerRef.current = undefined
      requestRef.current += 1
    }
  }, [connected, filters, onQuery])

  useEffect(() => () => {
    loadControllerRef.current?.abort()
    cancelAuditExport(exportControllerRef)
  }, [])

  const loadOlder = async () => {
    if (!page?.hasMore || !page.nextCursor || loading) return
    const request = ++requestRef.current
    const controller = new AbortController()
    loadControllerRef.current?.abort()
    loadControllerRef.current = controller
    const deadline = Deadline.start(auditQueryBudgetMs)
    setLoading(true)
    setError("")
    try {
      const older = await onQuery(
        { ...filters, before: page.nextCursor, limit: 50 },
        { signal: controller.signal, deadline },
      )
      if (request === requestRef.current) setPage((current) => mergeAuditPages(current, older))
    } catch (cause) {
      if (!controller.signal.aborted && request === requestRef.current) {
        setError(cause instanceof Error ? cause.message : "Older audit entries could not be loaded")
      }
    } finally {
      deadline.clear()
      if (loadControllerRef.current === controller) loadControllerRef.current = undefined
      if (request === requestRef.current) setLoading(false)
    }
  }

  const exportLog = async () => {
    if (!connected || exporting) return
    const controller = new AbortController()
    exportControllerRef.current = controller
    setExporting(true)
    setError("")
    try {
      downloadAuditExport(await collectAuditExport(onExport, filters, {
        signal: controller.signal,
        budgetMs: auditExportBudgetMs,
      }))
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Audit export could not be created")
      }
    } finally {
      if (exportControllerRef.current === controller) exportControllerRef.current = undefined
      setExporting(false)
    }
  }

  const toggleExport = () => {
    if (exporting) {
      cancelAuditExport(exportControllerRef)
      return
    }
    void exportLog()
  }

  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <main className="mx-auto flex w-full max-w-[900px] flex-col gap-[18px] px-6 pb-10 pt-[30px]">
        <header className="flex flex-col gap-[7px]">
          <h1 className="m-0 text-[19px] font-semibold tracking-[-0.01em]">Audit log</h1>
          <p className="m-0 text-[13px] leading-[1.62] text-muted-foreground">
            Every decision this machine recorded, across every session. This is the record the product actually promises, so it is a query rather than a feed: filter it, read it, export it, and it stays here.
          </p>
        </header>

        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-52 flex-1">
            <FieldLabel htmlFor="audit-search" className="sr-only">Search</FieldLabel>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
              <Input id="audit-search" className="rounded-full pl-9 font-machine text-[11px]" maxLength={512} placeholder="Search the audit log" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
          </Field>
          <Field className="w-48">
            <FieldLabel htmlFor="audit-action" className="sr-only">Action</FieldLabel>
            <Input id="audit-action" className="rounded-full font-machine text-[11px]" maxLength={512} placeholder="Action, for example terminal.create" value={action} onChange={(event) => setAction(event.target.value)} />
          </Field>
          <ToggleGroup type="single" value={outcome} onValueChange={(value) => { if (value) setOutcome(value as OutcomeFilter) }} variant="outline" size="sm" spacing={1} aria-label="Audit outcome" className="flex-wrap justify-start">
            {outcomes.map((value) => <ToggleGroupItem key={value} value={value} className="rounded-full px-3 capitalize">{value}</ToggleGroupItem>)}
          </ToggleGroup>
          <ToggleGroup type="single" value={actor} onValueChange={(value) => { if (value) setActor(value as ActorFilter) }} variant="outline" size="sm" spacing={1} aria-label="Audit actor" className="flex-wrap justify-start">
            {actors.map(([value, label]) => <ToggleGroupItem key={value} value={value} className="rounded-full px-3">{label}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>

        {error ? <Alert variant="destructive"><CircleStopIcon /><AlertTitle>Audit log unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}

        <section aria-label="Audit entries" className="overflow-hidden rounded-xl border bg-card">
          {page?.entries.map((entry) => <AuditEntryRow key={entry.id} entry={entry} />)}
          {!loading && !error && page?.entries.length === 0 ? (
            <Empty className="min-h-52 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon"><SearchIcon /></EmptyMedia>
                {Object.keys(filters).length === 0 ? <><EmptyTitle>This machine has recorded nothing yet</EmptyTitle><EmptyDescription>Approvals, sessions and terminals are written here as they happen.</EmptyDescription></> : <><EmptyTitle>No matching audit entries</EmptyTitle><EmptyDescription>Change search terms, action, or outcome.</EmptyDescription></>}
              </EmptyHeader>
            </Empty>
          ) : null}
          {loading && !page ? <p role="status" className="p-6 text-center font-machine text-[10px] text-faint">Loading audit log</p> : null}
        </section>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={!connected} onClick={toggleExport} aria-label={exporting ? "Cancel export" : "Export this query"}>
            <DownloadIcon data-icon="inline-start" />{exporting ? "Cancel export" : "Export this query"}
          </Button>
          <span className="font-machine text-[10.5px] text-faint">writes a file on this machine · {page?.entries.length ?? 0} rows loaded</span>
          {page?.hasMore ? <Button className="ml-auto" variant="outline" size="sm" disabled={loading} onClick={() => void loadOlder()}>{loading ? "Loading" : "Load older"}</Button> : null}
        </div>

        <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="audit-facts-title">
          <h2 id="audit-facts-title" className="m-0 border-b px-[15px] py-[11px] text-[10.5px] font-medium tracking-[0.13em] text-faint">WHAT THIS LOG IS, AND IS NOT</h2>
          {[
            "Rows name verified credentials, so renaming a device does not rewrite history.",
            "Retention is bounded by the daemon's local audit policy.",
            "It lives on this machine and is never uploaded.",
            "Export writes a redacted file here. Moving it is your decision.",
          ].map((fact) => <div key={fact} className="flex items-start gap-2.5 px-[15px] py-2.5 text-[12px] leading-[1.55] text-strong"><ShieldCheckIcon className="mt-1 size-3 shrink-0 text-success" />{fact}</div>)}
        </section>
      </main>
    </ScrollArea>
  )
}
