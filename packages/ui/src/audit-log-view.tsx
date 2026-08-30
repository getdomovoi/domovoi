import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeftIcon,
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
import { Field, FieldGroup, FieldLabel } from "./components/ui/field"
import { Input } from "./components/ui/input"
import { ScrollArea } from "./components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group"
import type { DomovoiRequestOptions } from "./client"

const outcomes = ["all", "started", "succeeded", "failed", "denied", "cancelled"] as const
type OutcomeFilter = (typeof outcomes)[number]
type AuditExportFilters = Omit<AuditExportParams, "before" | "format" | "limit">
type AuditDownload = Pick<AuditExportResult, "format" | "exportedAt" | "entryCount" | "content">
type AbortControllerHolder = { current: AbortController | undefined }

const maximumAuditDownloadPages = 20
const maximumAuditDownloadBytes = 20_000_000

export function auditActorLabel(actor: AuditActor): string {
  if (actor.kind === "client") return [actor.client, actor.clientId].filter(Boolean).join(" · ")
  if (actor.kind === "provider") {
    return [actor.provider, actor.providerThreadId].filter(Boolean).join(" · ")
  }
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
  options: { signal: AbortSignal; deadlineAt: number },
): Promise<AuditDownload> {
  const chunks: string[] = []
  const cursors = new Set<string>()
  let entryCount = 0
  let byteCount = 0
  let before: string | undefined
  let exportedAt = "1970-01-01T00:00:00.000Z"

  for (let pageIndex = 0; pageIndex < maximumAuditDownloadPages; pageIndex += 1) {
    options.signal.throwIfAborted()
    const remainingMs = Math.floor(options.deadlineAt - Date.now())
    if (remainingMs <= 0) throw new Error("Audit export deadline exceeded")
    const page = await onExport(
      {
        ...filters,
        format: "jsonl",
        limit: 500,
        ...(before ? { before } : {}),
      },
      { signal: options.signal, timeoutMs: remainingMs },
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
        <time className="ml-auto font-machine text-[9px] text-faint" dateTime={entry.occurredAt}>
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
  onBack,
  onOpenSkills,
  onQuery,
  onExport,
}: {
  connected: boolean
  initialPage?: AuditQueryPage
  onBack: () => void
  onOpenSkills: () => void
  onQuery: (params: AuditQueryParams, options?: DomovoiRequestOptions) => Promise<AuditQueryPage>
  onExport: (params: AuditExportParams, options?: DomovoiRequestOptions) => Promise<AuditExportResult>
}) {
  const [query, setQuery] = useState("")
  const [action, setAction] = useState("")
  const [outcome, setOutcome] = useState<OutcomeFilter>("all")
  const [page, setPage] = useState<AuditQueryPage | undefined>(initialPage)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState("")
  const requestRef = useRef(0)
  const loadControllerRef = useRef<AbortController | undefined>(undefined)
  const exportControllerRef = useRef<AbortController | undefined>(undefined)
  const filters = useMemo(() => ({
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(action.trim() ? { action: action.trim() } : {}),
    ...(outcome !== "all" ? { outcome: outcome as AuditOutcome } : {}),
  }), [action, outcome, query])
  const filterKey = JSON.stringify(filters)

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
    setLoading(true)
    setError("")
    void onQuery({ ...filters, limit: 50 }, { signal: controller.signal, timeoutMs: 15_000 }).then(
      (next) => { if (request === requestRef.current) setPage(next) },
      (cause: unknown) => {
        if (request === requestRef.current && !controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Audit log could not be loaded")
        }
      },
    ).finally(() => {
      if (request === requestRef.current) setLoading(false)
    })
    return () => {
      controller.abort()
      loadControllerRef.current?.abort()
      loadControllerRef.current = undefined
      requestRef.current += 1
    }
  }, [connected, filterKey, onQuery])

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
    setLoading(true)
    setError("")
    try {
      const older = await onQuery(
        { ...filters, before: page.nextCursor, limit: 50 },
        { signal: controller.signal, timeoutMs: 15_000 },
      )
      if (request === requestRef.current) setPage((current) => mergeAuditPages(current, older))
    } catch (cause) {
      if (!controller.signal.aborted && request === requestRef.current) {
        setError(cause instanceof Error ? cause.message : "Older audit entries could not be loaded")
      }
    } finally {
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
        deadlineAt: Date.now() + 60_000,
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
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Settings navigation" className="hidden w-[236px] shrink-0 flex-col border-r bg-sidebar p-2.5 sm:flex">
        <Button variant="ghost" className="mb-2 justify-start" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Workspace
        </Button>
        <div className="px-2 py-2 text-base font-semibold">Settings</div>
        <Button variant="ghost" className="justify-start" onClick={onOpenSkills}>Skills</Button>
        <Button variant="secondary" className="justify-start">Audit log</Button>
      </aside>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="mx-auto flex w-full max-w-[900px] flex-col px-4 py-5 sm:px-8 sm:py-7">
          <nav aria-label="Settings" className="mb-3 -ml-2 flex flex-wrap items-center gap-1 self-start sm:hidden">
            <Button variant="ghost" className="min-h-11" onClick={onBack}>
              <ArrowLeftIcon data-icon="inline-start" />
              Workspace
            </Button>
            <Button variant="ghost" className="min-h-11" onClick={onOpenSkills}>Skills</Button>
          </nav>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="m-0 text-[17px] font-semibold">Audit log</h1>
              <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
                Search redacted security, session, provider, approval, tool, and terminal events stored on this machine.
              </p>
            </div>
            <Button variant="outline" disabled={!connected} onClick={toggleExport}>
              <DownloadIcon data-icon="inline-start" />
              {exporting ? "Cancel export" : "Export JSONL"}
            </Button>
          </div>

          <FieldGroup className="mt-5 gap-3 sm:flex-row">
            <Field>
              <FieldLabel htmlFor="audit-search">Search</FieldLabel>
              <Input
                id="audit-search"
                maxLength={512}
                placeholder="Actor, target, action, or redacted detail"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="audit-action">Action</FieldLabel>
              <Input
                id="audit-action"
                maxLength={512}
                placeholder="terminal.create"
                value={action}
                onChange={(event) => setAction(event.target.value)}
              />
            </Field>
          </FieldGroup>

          <Field className="mt-3">
            <FieldLabel>Outcome</FieldLabel>
            <ToggleGroup
              type="single"
              value={outcome}
              onValueChange={(value) => { if (value) setOutcome(value as OutcomeFilter) }}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Audit outcome"
              className="flex-wrap justify-start"
            >
              {outcomes.map((value) => (
                <ToggleGroupItem key={value} value={value}>{value}</ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          {error ? (
            <Alert variant="destructive" className="mt-4">
              <CircleStopIcon />
              <AlertTitle>Audit log unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <section className="mt-5" aria-label="Audit entries">
            {page?.entries.map((entry) => <AuditEntryRow key={entry.id} entry={entry} />)}
            {!loading && !error && page?.entries.length === 0 ? (
              <Empty className="min-h-52 border">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><SearchIcon /></EmptyMedia>
                  <EmptyTitle>No matching audit entries</EmptyTitle>
                  <EmptyDescription>Change search terms, action, or outcome.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {loading && !page ? (
              <p role="status" className="p-6 text-center font-machine text-[10px] text-faint">Loading audit log</p>
            ) : null}
            {page?.hasMore ? (
              <Button className="mx-auto mt-4" variant="outline" size="sm" disabled={loading} onClick={() => void loadOlder()}>
                {loading ? "Loading" : "Load older"}
              </Button>
            ) : null}
            {!loading && page?.entries.length ? (
              <p className="mt-4 flex items-center justify-center gap-1.5 font-machine text-[9px] text-faint">
                <ShieldCheckIcon /> Stored and exported fields are redacted by the daemon.
              </p>
            ) : null}
          </section>
        </main>
      </ScrollArea>
    </div>
  )
}
