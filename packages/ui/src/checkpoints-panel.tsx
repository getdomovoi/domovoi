import type { RpcParams, SessionHistoryEntry, SessionHistoryPage } from "@getdomovoi/protocol"
import { CircleStopIcon, GitCommitHorizontalIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { CheckpointFork, CheckpointRestore } from "./checkpoint-actions.js"
import { SessionHistoryRequestController, latestSessionHistoryRequest, sessionHistoryEntryOutcome } from "./session-history.js"
import { StatusDot } from "./status-dot.js"

type CheckpointEntry = Extract<SessionHistoryEntry, { category: "checkpoints" }>

// The v2 design gives checkpoints a pane of their own beside History: every
// approved write takes one first, and reverting rewinds the worktree and the
// thread together. The rows are the checkpoints category of session history,
// newest first, so the daemon stays the one source of what a checkpoint is.
export const checkpointsIntro = "Every approved write takes one first. Reverting rewinds the worktree and the thread together."

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
}: {
  sessionId: string | null
  connected: boolean
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
  }, [connected, onLoad, sessionId])

  useEffect(() => () => controllerRef.current?.dispose(), [])

  const entries = (page?.items ?? []).filter((entry): entry is CheckpointEntry => entry.category === "checkpoints")

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
          {!loading && !error && page && entries.length === 0 ? (
            <Empty className="min-h-48 border-0"><EmptyHeader><EmptyMedia variant="icon"><GitCommitHorizontalIcon /></EmptyMedia>
              <EmptyTitle>No checkpoints yet</EmptyTitle>
              <EmptyDescription>The first approved write takes one, and the session start is recorded when the worktree is created.</EmptyDescription>
            </EmptyHeader></Empty>
          ) : null}
          {error ? <Alert variant="destructive" className="my-1"><CircleStopIcon /><AlertTitle>Checkpoints unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
          {loading && !page ? <p role="status" className="p-4 text-center font-machine text-[10px] text-faint">Loading checkpoints</p> : null}
        </div>
      </ScrollArea>
    </div>
  )
}
