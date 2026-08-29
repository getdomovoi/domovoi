import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckCircle2Icon,
  CircleStopIcon,
  FileDiffIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react"

import type { ChangedFileEvidence, SessionEvidence } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Badge } from "./components/ui/badge"
import { Button } from "./components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty"
import { ScrollArea } from "./components/ui/scroll-area"
import { Separator } from "./components/ui/separator"
import { cn } from "./lib/utils"

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

function FileEvidenceRow({ file }: { file: ChangedFileEvidence }) {
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
      <div className="flex items-start gap-1 font-machine text-[9px]">
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
    </div>
  )
}

export function SessionEvidenceContent({
  connected,
  evidence,
  error,
  loading,
  onRefresh,
}: {
  connected: boolean
  evidence?: SessionEvidence
  error: string
  loading: boolean
  onRefresh: () => void
}) {
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
                  </div>
                </div>
                <Separator />
                {evidence.workspace.files.length ? evidence.workspace.files.map((file) => (
                  <FileEvidenceRow key={file.path} file={file} />
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
                  {evidence.workspace.diffTruncated ? <Badge variant="warning">Truncated</Badge> : null}
                </div>
                <Separator />
                {evidence.workspace.diff ? (
                  <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words bg-code p-3 font-machine text-[10px] leading-relaxed text-muted-foreground">
                    {evidence.workspace.diff}
                  </pre>
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
    </div>
  )
}

export function SessionEvidencePanel({
  connected,
  sessionId,
  onLoad,
}: {
  connected: boolean
  sessionId: string | null
  onLoad: (sessionId: string) => Promise<SessionEvidence>
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
    />
  )
}
