import { useEffect, useMemo, useRef, useState } from "react"
import {
  CircleStopIcon,
  DownloadIcon,
  SearchIcon,
} from "lucide-react"

import type {
  AuditActor,
  AuditEntry,
  AuditExportParams,
  AuditExportResult,
  AuditOutcome,
  AuditQueryPage,
  AuditQueryParams,
  ClientKind,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
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

// The design colours a row's dot success, info or destructive. The outcome
// word sits in the row's last column, so the dot is never the only signal.
function outcomeDotClass(outcome: AuditOutcome): string {
  if (outcome === "succeeded") return "bg-success"
  if (outcome === "failed" || outcome === "denied") return "bg-destructive"
  return "bg-info"
}

const twoDigits = (value: number) => String(value).padStart(2, "0")

// The design draws a 24-hour time in a 62px column. Its query window is one
// day; this query has no window, so a row from another day also names the day.
function auditEntryTime(occurredAt: string, now = new Date()): { time: string; day?: string } {
  const at = new Date(occurredAt)
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map(twoDigits).join(":")
  if (at.toDateString() === now.toDateString()) return { time }
  const sameYear = at.getFullYear() === now.getFullYear()
  return {
    time,
    day: at.toLocaleDateString(undefined, sameYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" }),
  }
}

function auditRowsLoaded(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"} loaded`
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

// The design's row: outcome dot, time, the action with an actor pill over a
// detail line, then who and outcome columns. The list is a size container, so
// when the pane (not the window) is narrower than 48rem the two columns wrap
// under the action instead of squeezing it or running out of the pane.
function AuditEntryRow({ entry, now }: { entry: AuditEntry; now: Date }) {
  const when = auditEntryTime(entry.occurredAt, now)
  return (
    <article className="flex flex-wrap items-start gap-3 border-b px-[15px] py-3 last:border-b-0 @3xl:flex-nowrap">
      <span aria-hidden className={`mt-[5px] size-1.5 shrink-0 rounded-full ${outcomeDotClass(entry.outcome)}`} />
      <time className="mt-px flex w-[62px] shrink-0 flex-col font-machine text-[10.5px] text-faint" dateTime={entry.occurredAt} title={new Date(entry.occurredAt).toLocaleString()}>
        <span>{when.time}</span>
        {when.day ? <span>{when.day}</span> : null}
      </time>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-machine text-[11.5px] [overflow-wrap:anywhere]">{entry.action}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 font-machine text-[10.5px] text-muted-foreground">{entry.actor.kind}</span>
        </div>
        {entry.detail ? (
          <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-[1.45] text-strong [overflow-wrap:anywhere]">
            {entry.detail}
          </div>
        ) : null}
      </div>
      <div className="flex basis-full flex-col pl-[92px] font-machine text-[10.5px] leading-normal text-muted-foreground [overflow-wrap:anywhere] @3xl:w-[190px] @3xl:shrink-0 @3xl:basis-auto @3xl:pl-0">
        <span>{auditActorLabel(entry.actor)}</span>
      </div>
      <div className="flex basis-full flex-col pl-[92px] font-machine text-[10.5px] leading-normal text-faint [overflow-wrap:anywhere] @3xl:w-[150px] @3xl:shrink-0 @3xl:basis-auto @3xl:pl-0">
        <span>{entry.outcome}</span>
        {entry.target ? <span>target · {entry.target}</span> : null}
        {entry.sessionId ? <span>session · {entry.sessionId}</span> : null}
      </div>
    </article>
  )
}

// Q346 A (2026-10-02): a browser downloads the export to the device it runs
// on, so a browser client says so. A desktop, or a caller that does not say,
// keeps the drawn line.
function auditExportDestination(clientKind: ClientKind | undefined): string {
  return clientKind === "web" || clientKind === "tablet" || clientKind === "phone"
    ? "saves to this device"
    : "writes a file on this machine"
}

const auditFacts = [
  { text: "Rows name verified credentials, so renaming a device does not rewrite history.", dot: "bg-success" },
  // The daemon's fixed defaults in apps/daemon/src/audit-log.ts (Q377 A).
  { text: "Retention is by count: 10,000 activity and 1,000 pre-authentication entries.", dot: "bg-info" },
  { text: "It lives on this machine and is never uploaded.", dot: "bg-info" },
  // "redacted" is a dated deviation from the design (Q377 A): the export is redacted.
  { text: "Export writes a redacted file here. Moving it is your decision.", dot: "bg-info" },
] as const

export function AuditLogView({
  connected,
  clientKind,
  initialPage,
  onQuery,
  onExport,
}: {
  connected: boolean
  clientKind?: ClientKind
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
  // Rows from today show a time only, so "today" is re-read at the next local
  // midnight, whenever rows land, and when the window regains focus or the tab
  // becomes visible (a sleeping machine can hold a timer past midnight).
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const timer = setTimeout(() => setNow(new Date()), Math.max(1_000, midnight.getTime() - Date.now() + 1_000))
    return () => clearTimeout(timer)
  }, [now])
  useEffect(() => {
    const refresh = () => setNow((current) => {
      const next = new Date()
      return next.toDateString() === current.toDateString() ? current : next
    })
    refresh()
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [page])
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

        <section aria-label="Audit entries" className="@container overflow-hidden rounded-xl border bg-card">
          {page?.entries.map((entry) => <AuditEntryRow key={entry.id} entry={entry} now={now} />)}
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
          <span className="font-machine text-[10.5px] text-faint">{`${auditExportDestination(clientKind)} · ${auditRowsLoaded(page?.entries.length ?? 0)}`}</span>
          {page?.hasMore ? <Button className="ml-auto" variant="outline" size="sm" disabled={loading} onClick={() => void loadOlder()}>{loading ? "Loading" : "Load older"}</Button> : null}
        </div>

        <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="audit-facts-title">
          <h2 id="audit-facts-title" className="m-0 border-b px-[15px] py-[11px] text-[10.5px] font-medium tracking-[0.13em] text-faint">WHAT THIS LOG IS, AND IS NOT</h2>
          {auditFacts.map(({ text, dot }) => <div key={text} className="flex items-start gap-2.5 px-[15px] py-2.5 text-[12px] leading-[1.55] text-strong"><span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot}`} /><span>{text}</span></div>)}
        </section>
      </main>
    </ScrollArea>
  )
}
