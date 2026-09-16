import type { RpcParams, SessionHistoryEntry, SessionHistoryPage, WorkspaceSnapshot } from "@getdomovoi/protocol"
import { CircleStopIcon, GitCommitHorizontalIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { CheckpointFork, CheckpointRestore } from "./checkpoint-actions.js"
import { SessionHistoryRequestController, latestSessionHistoryRequest, mergeOlderHistory, sessionHistoryEntryOutcome } from "./session-history.js"
import { StatusDot } from "./status-dot.js"

type CheckpointEntry = Extract<SessionHistoryEntry, { category: "checkpoints" }>

// The v2 design gives checkpoints a pane of their own beside History. Its
// intro promises a checkpoint before every approved write and a revert that
// rewinds the thread with the worktree; the daemon does neither yet. It takes
// checkpoints at the events in reasonCopy below and on request, and
// checkpoint.restore resets the worktree after recording a recovery checkpoint
// while the thread keeps its turns. The copy states what runs; the design's
// promise is a recorded handoff gap. The rows are the checkpoints category of
// session history, which the daemon pages oldest first, shown newest first.
export const checkpointsIntro = "Domovoi takes one at session start, before a restore, a file revert, a provider change or an archive, and when you ask. Reverting resets the worktree to that commit after recording a recovery checkpoint. The thread keeps its turns."

// The reason names why the checkpoint exists; the design draws it beside the
// time. Legacy rows carry no reason and say so with nothing rather than a guess.
const reasonCopy: Record<NonNullable<CheckpointEntry["reason"]>, string> = {
  "session-start": "session start",
  fork: "fork",
  manual: "manual",
  "before-restore": "before a restore",
  "before-revert": "before a revert",
  "before-provider-handoff": "before a provider handoff",
  "before-provider-recovery": "before provider recovery",
  "before-archive": "before archiving",
}

// The id of the newest checkpoint item the snapshot holds for a session. The
// snapshot's thread is bounded, but the newest items are the ones it keeps, so
// this changes whenever the session records a checkpoint.
export function latestCheckpointRevision(snapshot: WorkspaceSnapshot, sessionId: string | null): string | undefined {
  if (!sessionId) return undefined
  for (let index = snapshot.thread.length - 1; index >= 0; index -= 1) {
    const item = snapshot.thread[index]!
    if (item.sessionId === sessionId && item.kind === "checkpoint") return item.id
  }
  return undefined
}

export function checkpointMeta(entry: CheckpointEntry): string {
  const time = entry.createdAt.slice(11, 16)
  return entry.reason ? `${time} · ${reasonCopy[entry.reason]}` : time
}

export function CheckpointsPanel({
  sessionId,
  connected,
  onLoad,
  onRestoreCheckpoint,
  onForkCheckpoint,
  restoreBlocked = false,
  revision,
}: {
  sessionId: string | null
  connected: boolean
  // The newest checkpoint the session snapshot knows about. It changes when a
  // checkpoint is created or a restore records its recovery checkpoint, and
  // the panel reloads on that change rather than showing a stale page.
  revision?: string | undefined
  onLoad: (
    sessionId: string,
    options?: Omit<RpcParams<"session.history">, "sessionId">,
    requestOptions?: { signal?: AbortSignal },
  ) => Promise<SessionHistoryPage>
  onRestoreCheckpoint?: ((checkpointId: string) => void) | undefined
  onForkCheckpoint?: ((checkpointId: string) => void) | undefined
  restoreBlocked?: boolean
}) {
  const [page, setPage] = useState<SessionHistoryPage>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const controllerRef = useRef<SessionHistoryRequestController<SessionHistoryPage> | null>(null)
  if (!controllerRef.current) controllerRef.current = new SessionHistoryRequestController<SessionHistoryPage>()

  useEffect(() => {
    setPage(undefined)
    setError("")
    if (!sessionId || !connected) {
      controllerRef.current!.cancel()
      setLoading(false)
      return
    }
    setLoading(true)
    controllerRef.current!.schedule({
      debounce: false,
      load: (signal) => onLoad(sessionId, latestSessionHistoryRequest(["checkpoints"], ""), { signal }),
      onSuccess: setPage,
      onError: (cause) => {
        setError(cause instanceof Error ? cause.message : "Checkpoints could not be loaded")
      },
      onSettled: () => setLoading(false),
    })
  }, [connected, onLoad, revision, sessionId])

  useEffect(() => () => controllerRef.current?.dispose(), [])

  const loadOlder = () => {
    if (!sessionId || !page?.hasMore || !page.nextCursor || loading) return
    setLoading(true)
    setError("")
    controllerRef.current!.schedule({
      debounce: false,
      load: (signal) => onLoad(sessionId, { ...latestSessionHistoryRequest(["checkpoints"], ""), before: page.nextCursor }, { signal }),
      onSuccess: (older) => setPage(mergeOlderHistory(page, older)),
      onError: (cause) => {
        setError(cause instanceof Error ? cause.message : "Older checkpoints could not be loaded")
      },
      onSettled: () => setLoading(false),
    })
  }

  const entries = (page?.items ?? [])
    .filter((entry): entry is CheckpointEntry => entry.category === "checkpoints")
    .reverse()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div data-testid="checkpoints-content" className="flex w-0 min-w-full flex-col gap-2 p-3">
          <p className="text-[12px] leading-relaxed text-muted-foreground">{checkpointsIntro}</p>
          {entries.map((entry) => {
            const outcome = sessionHistoryEntryOutcome(entry)
            const sessionStart = entry.reason === "session-start"
            return (
              // Dot, id, label, meta, then the two decisions. The id and the
              // meta hold fixed columns so the labels line up down the list.
              <div key={entry.id} data-testid="checkpoint-row" className="flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5">
                <StatusDot meaning={outcome.meaning} label={outcome.label} size="inline" labelHidden />
                <span className="w-[78px] shrink-0 truncate font-machine text-[11px] text-strong">{entry.sourceId}</span>
                <span className="min-w-0 flex-1 truncate text-[12px]">{entry.label}</span>
                <span data-testid="checkpoint-meta" className="w-[132px] shrink-0 truncate text-right font-machine text-mono-xs text-faint">{checkpointMeta(entry)}</span>
                {/* Restore and fork are two decisions about one row. A checkpoint
                    that names no commit offers neither. The session-start row is
                    the worktree's base, so forking from it makes a session
                    identical to a new one: the design draws Fork absent there
                    and calls the restore Reset. */}
                {entry.commit && onForkCheckpoint && !sessionStart ? (
                  <CheckpointFork checkpointId={entry.sourceId} label={entry.label} disabled={restoreBlocked} onFork={onForkCheckpoint} triggerLabel="Fork" triggerVariant="outline" />
                ) : null}
                {entry.commit && onRestoreCheckpoint ? (
                  <CheckpointRestore checkpointId={entry.sourceId} label={entry.label} disabled={restoreBlocked} onRestore={onRestoreCheckpoint} triggerLabel={sessionStart ? "Reset" : "Revert"} triggerVariant="outline" />
                ) : null}
              </div>
            )
          })}
          {page?.hasMore ? <Button className="my-1 self-center" variant="outline" size="sm" disabled={loading} onClick={loadOlder}>{loading ? "Loading" : "Load older"}</Button> : null}
          {!loading && !error && page && entries.length === 0 ? (
            <Empty className="min-h-48 border-0"><EmptyHeader><EmptyMedia variant="icon"><GitCommitHorizontalIcon /></EmptyMedia>
              <EmptyTitle>No checkpoints yet</EmptyTitle>
              <EmptyDescription>The session start is recorded when the worktree is created. The next one comes at a restore, a handoff, an archive, or when you ask.</EmptyDescription>
            </EmptyHeader></Empty>
          ) : null}
          {error ? <Alert variant="destructive" className="my-1"><CircleStopIcon /><AlertTitle>Checkpoints unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
          {loading && !page ? <p role="status" className="p-4 text-center font-machine text-[10px] text-faint">Loading checkpoints</p> : null}
        </div>
      </ScrollArea>
    </div>
  )
}
