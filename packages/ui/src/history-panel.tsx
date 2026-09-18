import { useEffect, useRef, useState } from "react"
import { CircleStopIcon, HistoryIcon, SearchIcon } from "lucide-react"
import type { RpcParams, SessionHistoryCategory, SessionHistoryPage } from "@getdomovoi/protocol"
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { CheckpointFork, CheckpointRestore } from "./checkpoint-actions.js"
import type { SessionHistoryFocus } from "./session-history"
import { StatusDot } from "./status-dot"
import {
  latestSessionHistoryRequest,
  historyWindowedAfterMerge,
  mergeOlderHistory,
  resetSessionHistoryWindow,
  SessionHistoryRequestController,
  sessionHistoryCategories,
  sessionHistoryEntryBody,
  sessionHistoryEntryDetail,
  sessionHistoryEntryOutcome,
  sessionHistoryEntryTitle,
} from "./session-history"

export function HistoryPanel({
  sessionId,
  connected,
  focus,
  onForkCheckpoint,
  worktreeName,
  onLoad,
  onRestoreCheckpoint,
  restoreBlocked = false,
}: {
  sessionId: string | null
  connected: boolean
  focus?: SessionHistoryFocus | undefined
  // A row gets Fork from here when it names a point you can resume from. Only a
  // checkpoint does: sessionForkParamsSchema takes a checkpointId, and the
  // daemon makes checkpoints at events rather than per turn.
  onForkCheckpoint?: ((checkpointId: string) => void) | undefined
  // The worktree a checkpoint belongs to is on the session, not on the entry,
  // and history is requested per session, so the shell hands it down.
  worktreeName?: string | undefined
  onRestoreCheckpoint?: ((checkpointId: string) => void) | undefined
  restoreBlocked?: boolean
  onLoad: (
    sessionId: string,
    options?: Omit<RpcParams<"session.history">, "sessionId">,
    requestOptions?: { signal?: AbortSignal },
  ) => Promise<SessionHistoryPage>
}) {
  const [categories, setCategories] = useState<SessionHistoryCategory[]>(() =>
    sessionHistoryCategories.map(({ value }) => value)
  )
  const [query, setQuery] = useState("")
  const [page, setPage] = useState<SessionHistoryPage>()
  const [historyWindowed, setHistoryWindowed] = useState(false)
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const requestControllerRef = useRef<SessionHistoryRequestController<SessionHistoryPage> | null>(null)
  if (!requestControllerRef.current) {
    requestControllerRef.current = new SessionHistoryRequestController<SessionHistoryPage>()
  }
  const previousSearchRef = useRef<{ context: string; query: string } | null>(null)
  // The effect below runs on what the filters say, not on the identity of the
  // arrays and strings they arrive in, so it reads the latest through a ref.
  const filtersRef = useRef({ categories, query })
  filtersRef.current = { categories, query }
  const filterKey = `${categories.join(",")}:${query.trim()}`

  useEffect(() => {
    setPage(undefined)
    setHistoryWindowed(false)
    setError("")
    if (!sessionId || !connected) {
      requestControllerRef.current!.cancel()
      setLoading(false)
      return
    }
    const { categories: activeCategories, query: activeQuery } = filtersRef.current
    const context = `${sessionId}:${activeCategories.join(",")}`
    const trimmedQuery = activeQuery.trim()
    const previous = previousSearchRef.current
    const debounce = previous?.context === context && previous.query !== trimmedQuery
    previousSearchRef.current = { context, query: trimmedQuery }
    setLoading(true)
    requestControllerRef.current!.schedule({
      debounce,
      load: (signal) => onLoad(
        sessionId,
        latestSessionHistoryRequest(activeCategories, trimmedQuery),
        { signal },
      ),
      onSuccess: setPage,
      onError: (cause) => {
        setError(cause instanceof Error ? cause.message : "Session history could not be loaded")
      },
      onSettled: () => setLoading(false),
    })
  }, [connected, filterKey, historyRefresh, onLoad, sessionId])

  // A focus request narrows the filters to the one category it names. The
  // Checkpoints affordances open their own tab now; the mechanism stays for any
  // caller that wants History narrowed rather than the checkpoints pane.
  const appliedFocusRef = useRef<number | null>(null)
  useEffect(() => {
    if (!focus || appliedFocusRef.current === focus.requestId) return
    appliedFocusRef.current = focus.requestId
    setCategories([focus.category])
  }, [focus])

  useEffect(() => () => requestControllerRef.current?.dispose(), [])

  const toggleCategory = (category: SessionHistoryCategory) => {
    if (categories.includes(category) && categories.length === 1) return
    setPage(undefined)
    setCategories((current) => current.includes(category)
      ? current.length === 1 ? current : current.filter((value) => value !== category)
      : sessionHistoryCategories.map(({ value }) => value).filter(
        (value) => value === category || current.includes(value),
      ))
  }

  const loadOlder = () => {
    if (!sessionId || !page?.hasMore || !page.nextCursor || loading) return
    setLoading(true)
    setError("")
    requestControllerRef.current!.schedule({
      debounce: false,
      load: (signal) => onLoad(
        sessionId,
        {
          categories,
          ...(query.trim() ? { query: query.trim() } : {}),
          before: page.nextCursor,
          limit: 50,
        },
        { signal },
      ),
      onSuccess: (older) => {
        setHistoryWindowed((current) => historyWindowedAfterMerge(current, page, older))
        setPage(mergeOlderHistory(page, older))
      },
      onError: (cause) => {
        setError(cause instanceof Error ? cause.message : "Older history could not be loaded")
      },
      onSettled: () => setLoading(false),
    })
  }

  const backToLatest = () => {
    const reset = resetSessionHistoryWindow({ page, historyWindowed, historyRefresh })
    setPage(reset.page)
    setHistoryWindowed(reset.historyWindowed)
    setHistoryRefresh(reset.historyRefresh)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-faint" />
          <Input
            aria-label="Search session history"
            className="pl-8 font-machine text-[10px]"
            placeholder="Search recorded history"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="xs"
            variant={categories.length === sessionHistoryCategories.length ? "secondary" : "ghost"}
            aria-pressed={categories.length === sessionHistoryCategories.length}
            onClick={() => {
              // Already the state: nothing to reload, and clearing the page
              // with the filter unchanged would leave it empty for good.
              if (categories.length === sessionHistoryCategories.length) return
              setPage(undefined)
              setCategories(sessionHistoryCategories.map(({ value }) => value))
            }}
          >
            Everything
          </Button>
          {sessionHistoryCategories.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={categories.includes(value) ? "secondary" : "ghost"}
              aria-pressed={categories.includes(value)}
              onClick={() => toggleCategory(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {/* The viewport lays its content out as a table that grows to the
            widest child, so a one-line title with nowrap would widen the whole
            list past the viewport instead of ellipsing. w-0 with min-w-full
            contributes no intrinsic width to that table and still fills it,
            so the rows are bound to the viewport and truncate has an edge. */}
        <div data-testid="history-content" className="flex w-0 min-w-full flex-col p-3">
          {page?.items.length ? (
          <div data-testid="history-rows" className="rounded-xl border">
          {page.items.map((entry) => {
            const detail = sessionHistoryEntryDetail(entry, { worktreeName })
            const body = sessionHistoryEntryBody(entry)
            const outcome = sessionHistoryEntryOutcome(entry)
            return (
              // Dot, time, content. The time holds a column of its own so the
              // titles line up down the list instead of starting wherever the
              // time before them happened to end.
              <div key={entry.id} data-testid="history-row" className="flex items-start gap-2 border-b px-3 py-3 last:border-b-0">
                <StatusDot meaning={outcome.meaning} label={outcome.label} size="inline" labelHidden className="mt-1.5" />
                <span data-testid="history-time" className="mt-0.5 w-[42px] shrink-0 font-machine text-mono-xs text-faint">{entry.createdAt.slice(11, 16)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{sessionHistoryEntryTitle(entry)}</span>
                    <Badge variant="outline" className="shrink-0 font-machine text-mono-xs">{entry.category}</Badge>
                  </div>
                  {/* Wraps rather than truncates: the scroll viewport's content
                      box grows to its widest child, so a truncated line widens
                      the whole list and the viewport hides the rest. */}
                  {detail ? <p data-testid="history-meta" className="break-words font-machine text-mono-xs text-muted-foreground">{detail}</p> : null}
                  {body ? (
                    // The row says what happened in one line. What it produced
                    // is still here, it just stops being the row.
                    <details className="mt-1">
                      <summary className="cursor-pointer font-machine text-mono-xs text-faint">Output</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-machine text-[10px] leading-relaxed text-muted-foreground">{body}</pre>
                    </details>
                  ) : null}
                  {/* Restore and fork are two decisions about one row, not one
                      control with two buttons, so each asks for itself. What
                      they share is the commit: a checkpoint that names no state
                      offers neither, because there is nothing to go back to and
                      nothing to branch from. */}
                  {entry.category === "checkpoints" && entry.commit && (onRestoreCheckpoint || onForkCheckpoint) ? (
                    <div className="mt-2 flex gap-1">
                      {onRestoreCheckpoint ? (
                        <CheckpointRestore
                          // sourceId, not id: the daemon builds history ids as
                          // thread:<checkpoint-id> and checkpoint.restore searches
                          // by the checkpoint id it kept in sourceId.
                          checkpointId={entry.sourceId}
                          label={entry.label}
                          disabled={restoreBlocked}
                          onRestore={onRestoreCheckpoint}
                        />
                      ) : null}
                      {/* The session-start checkpoint is the worktree's base
                          commit, so forking from it produces a session identical
                          to starting a new one. The design draws it absent
                          rather than disabled, because a disabled control still
                          says the decision exists. A legacy row carries no
                          reason and is not guessed into this branch: it keeps
                          the fork it has always had. */}
                      {onForkCheckpoint && entry.reason !== "session-start" ? (
                        <CheckpointFork
                          checkpointId={entry.sourceId}
                          label={sessionHistoryEntryTitle(entry)}
                          disabled={restoreBlocked}
                          onFork={onForkCheckpoint}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            )
          })}
          </div>
          ) : null}
          {/* Same pair as the audit log, and the same fix. A session before its
              first turn has nothing narrowing its history: every category is
              selected and the search is empty, so "change filters" names a
              control that is already showing everything. */}
          {!loading && !error && page?.items.length === 0 ? (
            <Empty className="min-h-48 border-0"><EmptyHeader><EmptyMedia variant="icon"><HistoryIcon /></EmptyMedia>
              {categories.length === sessionHistoryCategories.length && query.trim() === "" ? (
                <>
                  <EmptyTitle>Nothing has happened in this session yet</EmptyTitle>
                  <EmptyDescription>Turns, approvals and checkpoints appear here as they happen.</EmptyDescription>
                </>
              ) : (
                <>
                  <EmptyTitle>No matching history</EmptyTitle>
                  <EmptyDescription>Change filters or search terms.</EmptyDescription>
                </>
              )}
            </EmptyHeader></Empty>
          ) : null}
          {error ? <Alert variant="destructive" className="my-3"><CircleStopIcon /><AlertTitle>History unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
          {historyWindowed ? <Button className="my-3 self-center" variant="ghost" size="sm" disabled={loading} onClick={backToLatest}>Back to latest</Button> : null}
          {page?.hasMore ? <Button className="my-3 self-center" variant="outline" size="sm" disabled={loading} onClick={() => void loadOlder()}>{loading ? "Loading" : "Load older"}</Button> : null}
          {loading && !page ? <p role="status" className="p-4 text-center font-machine text-[10px] text-faint">Loading history</p> : null}
        </div>
      </ScrollArea>
    </div>
  )
}
