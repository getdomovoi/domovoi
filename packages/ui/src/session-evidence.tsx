import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckCircle2Icon,
  CircleStopIcon,
  FileDiffIcon,
  RefreshCwIcon,
  Undo2Icon,
  XCircleIcon,
} from "lucide-react"

import type { ChangedFileEvidence, SessionEvidence } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { Separator } from "./components/ui/separator"
import { cn } from "./lib/utils"

export type DiffView = "unified" | "split"

export type SplitDiffRow = {
  kind: "meta" | "context" | "change"
  left: string | null
  right: string | null
}

const diffMetaPrefixes = [
  "diff --git",
  "index ",
  "new file",
  "deleted file",
  "old mode",
  "new mode",
  "similarity index",
  "rename ",
  "copy ",
  "Binary files",
  "@@",
  "--- ",
  "+++ ",
]

// A split view is the same unified hunks read as two columns, so it needs no
// diff library: removals stack on the left, additions on the right, and the
// pair is flushed whenever the hunk returns to shared context.
export function splitDiffRows(diff: string): SplitDiffRow[] {
  const rows: SplitDiffRow[] = []
  let removed: string[] = []
  let added: string[] = []
  const flush = () => {
    const height = Math.max(removed.length, added.length)
    for (let index = 0; index < height; index += 1) {
      rows.push({ kind: "change", left: removed[index] ?? null, right: added[index] ?? null })
    }
    removed = []
    added = []
  }
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    if (diffMetaPrefixes.some((prefix) => line.startsWith(prefix))) {
      flush()
      rows.push({ kind: "meta", left: line, right: line })
      continue
    }
    if (line.startsWith("-")) {
      removed.push(line.slice(1))
      continue
    }
    if (line.startsWith("+")) {
      added.push(line.slice(1))
      continue
    }
    flush()
    const text = line.startsWith(" ") ? line.slice(1) : line
    rows.push({ kind: "context", left: text, right: text })
  }
  flush()
  return rows
}

export function changedFileCounts(files: ChangedFileEvidence[]): {
  added: number
  modified: number
  deleted: number
} {
  let added = 0
  let modified = 0
  let deleted = 0
  for (const file of files) {
    if (file.status === "added" || file.status === "untracked") added += 1
    else if (file.status === "deleted") deleted += 1
    else modified += 1
  }
  return { added, modified, deleted }
}

type EvidenceState = {
  sessionId?: string
  evidence?: SessionEvidence
  loading: boolean
  error: string
}

function fileStage(file: ChangedFileEvidence): string {
  if (file.staged && file.unstaged) return "staged + unstaged"
  if (file.staged) return "staged"
  if (file.unstaged) return "unstaged"
  return "unchanged"
}

function FileEvidenceRow({
  file,
  onRevert,
  revertDisabled,
}: {
  file: ChangedFileEvidence
  onRevert?: (() => void) | undefined
  revertDisabled?: boolean
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b px-3 py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-machine text-[10px] text-strong" title={file.path}>
            {file.path}
          </span>
          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[8px]">{file.status}</Badge>
          {file.binary ? <Badge variant="outline" className="h-4 shrink-0 px-1 text-[8px]">binary</Badge> : null}
        </div>
        {file.previousPath ? (
          <p className="mt-1 truncate font-machine text-[9px] text-faint">from {file.previousPath}</p>
        ) : null}
        <p className="mt-1 font-machine text-[9px] text-faint">{fileStage(file)}</p>
      </div>
      <div className="flex items-start gap-2 font-machine text-[9px]">
        <div className="flex items-start gap-1">
          {file.binary || file.additions === null || file.deletions === null ? (
            <span className="text-faint">
              {file.binary ? "binary" : file.status === "untracked" ? "not in diff" : "no line counts"}
            </span>
          ) : (
            <>
              <span className="text-success">+{file.additions}</span>
              <span className="text-destructive">−{file.deletions}</span>
            </>
          )}
        </div>
        {onRevert ? (
          <Button
            variant="outline"
            size="xs"
            disabled={revertDisabled}
            aria-label={`Revert ${file.path}`}
            onClick={onRevert}
          >
            <Undo2Icon />
            Revert file
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function RevertFileDialog({
  path,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  path: string
  pending: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !pending) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revert this file to the session base commit?</AlertDialogTitle>
          <AlertDialogDescription>
            Domovoi takes a recovery checkpoint before it changes the worktree, so this stays
            restorable. Uncommitted work in this file is discarded, and a file the worktree is not
            tracking is removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="m-0 truncate font-machine text-[10px] text-strong" title={path}>{path}</p>
        {error ? <p role="alert" className="m-0 text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep the changes</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? "Reverting" : "Revert file"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function SplitDiff({ diff }: { diff: string }) {
  const rows = useMemo(() => splitDiffRows(diff), [diff])
  return (
    <div aria-label="Split diff" className="max-h-80 overflow-auto bg-code font-machine text-[10px] leading-relaxed">
      <div className="grid min-w-max grid-cols-2">
        {rows.map((row, index) => (
          <div key={index} className="contents">
            <pre
              className={cn(
                "m-0 whitespace-pre px-3 py-0.5",
                row.kind === "meta" && "text-faint",
                row.kind === "change" && row.left !== null && "bg-destructive/10 text-destructive",
                row.kind === "context" && "text-muted-foreground",
              )}
            >
              {row.left ?? ""}
            </pre>
            <pre
              className={cn(
                "m-0 whitespace-pre border-l px-3 py-0.5",
                row.kind === "meta" && "text-faint",
                row.kind === "change" && row.right !== null && "bg-success/10 text-success",
                row.kind === "context" && "text-muted-foreground",
              )}
            >
              {row.right ?? ""}
            </pre>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SessionEvidenceContent({
  connected,
  evidence,
  error,
  loading,
  onRefresh,
  onRevertFile,
}: {
  connected: boolean
  evidence?: SessionEvidence
  error: string
  loading: boolean
  onRefresh: () => void
  onRevertFile?: (path: string) => Promise<void>
}) {
  const [diffView, setDiffView] = useState<DiffView>("unified")
  const [revertPath, setRevertPath] = useState<string | null>(null)
  const [revertPending, setRevertPending] = useState(false)
  const [revertError, setRevertError] = useState("")
  const counts = changedFileCounts(evidence?.workspace.files ?? [])
  const confirmRevert = useCallback(() => {
    if (!onRevertFile || revertPath === null) return
    setRevertPending(true)
    setRevertError("")
    void onRevertFile(revertPath).then(
      () => {
        setRevertPending(false)
        setRevertPath(null)
      },
      (cause: unknown) => {
        setRevertPending(false)
        setRevertError(cause instanceof Error ? cause.message : "The file could not be reverted")
      },
    )
  }, [onRevertFile, revertPath])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <div>
          <p className="m-0 text-[11px] font-medium">Session evidence</p>
          <p className="m-0 font-machine text-[9px] text-faint">
            {evidence ? `refreshed ${evidence.refreshedAt}` : "Git and recorded tool state"}
          </p>
        </div>
        <Button
          variant="outline"
          size="xs"
          disabled={!connected || loading}
          onClick={onRefresh}
        >
          <RefreshCwIcon className={cn(loading && "motion-safe:animate-spin")} />
          Refresh
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {loading && !evidence ? (
            <p role="status" className="py-8 text-center font-machine text-[10px] text-faint">
              Refreshing evidence
            </p>
          ) : null}
          {error ? (
            <Alert variant="destructive" aria-live="polite">
              <CircleStopIcon />
              <AlertTitle>Evidence unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {!connected && !error ? (
            <Alert>
              <CircleStopIcon />
              <AlertTitle>Evidence unavailable</AlertTitle>
              <AlertDescription>Reconnect to read current Git and tool state.</AlertDescription>
            </Alert>
          ) : null}
          {evidence ? (
            <>
              <section className="overflow-hidden rounded-lg border bg-card">
                <div className="flex items-center justify-between px-3 py-2">
                  <div>
                    <h3 className="m-0 text-[11px] font-medium">Working tree</h3>
                    <p className="mt-0.5 font-machine text-[9px] text-faint">
                      {evidence.workspace.totalChangedFiles} changed files · {evidence.workspace.baseCommit.slice(0, 8)}
                    </p>
                    <p className="mt-0.5 font-machine text-[9px] text-faint">
                      {counts.added} added · {counts.modified} modified · {counts.deleted} deleted
                    </p>
                  </div>
                </div>
                <Separator />
                {evidence.workspace.files.length ? evidence.workspace.files.map((file) => (
                  <FileEvidenceRow
                    key={file.path}
                    file={file}
                    {...(onRevertFile
                      ? { onRevert: () => { setRevertError(""); setRevertPath(file.path) } }
                      : {})}
                    revertDisabled={!connected || revertPending}
                  />
                )) : (
                  <Empty className="min-h-28 border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><FileDiffIcon /></EmptyMedia>
                      <EmptyTitle>No working changes</EmptyTitle>
                      <EmptyDescription>Git reports a clean worktree.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {evidence.workspace.filesTruncated ? (
                  <p className="border-t px-3 py-2 font-machine text-[9px] text-warning">
                    Only the first {evidence.workspace.files.length} changed files are shown.
                  </p>
                ) : null}
              </section>

              <section className="overflow-hidden rounded-lg border bg-card">
                <div className="flex items-center justify-between px-3 py-2">
                  <h3 className="m-0 text-[11px] font-medium">Worktree diff</h3>
                  <div className="flex items-center gap-2">
                    {evidence.workspace.diffTruncated ? <Badge variant="warning">Truncated</Badge> : null}
                    <div className="flex items-center gap-1" role="group" aria-label="Diff view">
                      <Button
                        variant={diffView === "unified" ? "secondary" : "ghost"}
                        size="xs"
                        aria-pressed={diffView === "unified"}
                        onClick={() => setDiffView("unified")}
                      >
                        Unified
                      </Button>
                      <Button
                        variant={diffView === "split" ? "secondary" : "ghost"}
                        size="xs"
                        aria-pressed={diffView === "split"}
                        onClick={() => setDiffView("split")}
                      >
                        Split
                      </Button>
                    </div>
                  </div>
                </div>
                <Separator />
                {evidence.workspace.diff ? (
                  diffView === "split" ? (
                    <SplitDiff diff={evidence.workspace.diff} />
                  ) : (
                    <pre
                      aria-label="Unified diff"
                      className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words bg-code p-3 font-machine text-[10px] leading-relaxed text-muted-foreground"
                    >
                      {evidence.workspace.diff}
                    </pre>
                  )
                ) : (
                  <p className="m-0 px-3 py-5 text-center text-[11px] text-faint">No diff output.</p>
                )}
                {evidence.workspace.diffTruncated ? (
                  <p className="border-t px-3 py-2 font-machine text-[9px] text-warning">
                    Diff output was truncated at the transport bound.
                  </p>
                ) : null}
              </section>

              <section className="overflow-hidden rounded-lg border bg-card">
                <div className="flex items-center justify-between px-3 py-2">
                  <div>
                    <h3 className="m-0 text-[11px] font-medium">Observed test runs</h3>
                    <p className="mt-0.5 font-machine text-[9px] text-faint">
                      {evidence.tests.passed} passed · {evidence.tests.failed} failed · {evidence.tests.totalRuns} command runs
                    </p>
                  </div>
                </div>
                <Separator />
                {evidence.tests.runs.length ? evidence.tests.runs.map((run) => (
                  <div key={run.id} className="border-b px-3 py-2 last:border-b-0">
                    <div className="flex items-start gap-2">
                      {run.status === "passed" ? (
                        <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-success" />
                      ) : (
                        <XCircleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="m-0 break-all font-machine text-[10px] text-strong">{run.command}</p>
                        <div className="mt-1 flex flex-wrap gap-2 font-machine text-[8px] text-faint">
                          <span>{run.createdAt}</span>
                          {run.commandTruncated ? <span className="text-warning">Command truncated</span> : null}
                          {run.outputTruncated ? <span className="text-warning">Output truncated</span> : null}
                        </div>
                        {run.output ? (
                          <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code p-2 font-machine text-[9px] text-muted-foreground">
                            {run.output}
                          </pre>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )) : (
                  <Empty className="min-h-28 border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><CheckCircle2Icon /></EmptyMedia>
                      <EmptyTitle>No observed test runs</EmptyTitle>
                      <EmptyDescription>Completed test commands recorded by this session appear here.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
                {evidence.tests.runsTruncated ? (
                  <p className="border-t px-3 py-2 font-machine text-[9px] text-warning">
                    Older observed runs are not shown.
                  </p>
                ) : null}
              </section>
            </>
          ) : null}
        </div>
      </ScrollArea>
      {onRevertFile && revertPath !== null ? (
        <RevertFileDialog
          path={revertPath}
          pending={revertPending}
          error={revertError}
          onCancel={() => { setRevertPath(null); setRevertError("") }}
          onConfirm={confirmRevert}
        />
      ) : null}
    </div>
  )
}

export function SessionEvidencePanel({
  connected,
  readOnly,
  sessionId,
  onLoad,
  onRevertFile,
}: {
  connected: boolean
  readOnly?: boolean
  sessionId: string | null
  onLoad: (sessionId: string) => Promise<SessionEvidence>
  onRevertFile?: (sessionId: string, path: string) => Promise<void>
}) {
  const generation = useRef(0)
  const [state, setState] = useState<EvidenceState>({ loading: false, error: "" })
  const refresh = useCallback(() => {
    const request = ++generation.current
    if (!sessionId) {
      setState({ loading: false, error: "" })
      return
    }
    if (!connected) {
      setState({ sessionId, loading: false, error: "" })
      return
    }
    setState((current) => ({
      sessionId,
      ...(current.sessionId === sessionId && current.evidence
        ? { evidence: current.evidence }
        : {}),
      loading: true,
      error: "",
    }))
    void onLoad(sessionId).then(
      (evidence) => {
        if (generation.current === request) {
          setState({ sessionId, evidence, loading: false, error: "" })
        }
      },
      (cause: unknown) => {
        if (generation.current === request) {
          setState({
            sessionId,
            loading: false,
            error: cause instanceof Error ? cause.message : "Session evidence could not be loaded",
          })
        }
      },
    )
  }, [connected, onLoad, sessionId])

  useEffect(() => {
    refresh()
    return () => { generation.current += 1 }
  }, [refresh])

  if (!sessionId) {
    return (
      <Empty className="min-h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileDiffIcon /></EmptyMedia>
          <EmptyTitle>No session is active</EmptyTitle>
          <EmptyDescription>Open a session to inspect its worktree evidence.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const visible: EvidenceState = state.sessionId === sessionId
    ? state
    : { loading: connected, error: "" }
  return (
    <SessionEvidenceContent
      connected={connected}
      {...(visible.evidence ? { evidence: visible.evidence } : {})}
      error={visible.error}
      loading={visible.loading}
      onRefresh={refresh}
      {...(onRevertFile && !readOnly
        ? {
          onRevertFile: async (path: string) => {
            await onRevertFile(sessionId, path)
            refresh()
          },
        }
        : {})}
    />
  )
}
