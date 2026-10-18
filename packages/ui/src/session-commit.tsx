import { useState } from "react"
import { CircleStopIcon, GitCommitHorizontalIcon } from "lucide-react"

import type { ChangedFileEvidence, Runtime } from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import { Textarea } from "./components/ui/textarea"

// What the Changes tab needs to commit a session's work (walk finding F10).
export type SessionCommitControls = {
  // The message the field starts with: the session's title, which the person
  // edits before committing.
  defaultMessage: string
  machine: string
  // Why this session cannot commit now: a read-only mode or a running turn.
  // The daemon refuses the same cases; the card says so before it is asked.
  blocked?: string | undefined
  onCommit: (message: string, expectedHead: string) => Promise<void>
}

// Why a session cannot commit now, in the daemon's own words for the same
// refusals (server.ts session.commit): Ask and Plan run read-only, and a
// commit waits for the turn. Undefined when it can.
export function sessionCommitBlocked(session: { runtime: Pick<Runtime, "permissionMode">, activeTurnId?: string | undefined }): string | undefined {
  if (session.runtime.permissionMode !== "build") {
    const mode = session.runtime.permissionMode === "ask" ? "Ask" : "Plan"
    return `This session is in ${mode}, which is read-only, so Domovoi does not commit in it. Switch it to Build to commit.`
  }
  if (session.activeTurnId) return "Stop the active turn before committing"
  return undefined
}

// The status a file row shows, in the evidence rows' own letters.
const statusLetter: Record<ChangedFileEvidence["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  conflicted: "!",
}

// Desktop V2 J27's COMMITS card, as far as the daemon builds it: one commit
// of every change in the worktree on the session branch, with the person's
// message. The design's plan-step grouping, Split again, moving files between
// commits, the agent trailer and pushing are not built (dock.commits stays
// partial). Nothing is committed until the person presses Commit here.
export function SessionCommitCard({
  controls,
  files,
  totalFiles,
  baseCommit,
  onCancel,
  onCommitted,
}: {
  controls: SessionCommitControls
  files: readonly ChangedFileEvidence[]
  totalFiles: number
  baseCommit: string
  onCancel: () => void
  onCommitted: () => void
}) {
  const [message, setMessage] = useState(controls.defaultMessage)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const commit = () => {
    if (pending || controls.blocked !== undefined || !message.trim()) return
    setPending(true)
    setError("")
    void controls.onCommit(message, baseCommit).then(
      () => {
        setPending(false)
        onCommitted()
      },
      (cause: unknown) => {
        setPending(false)
        setError(cause instanceof Error ? cause.message : "The commit failed")
      },
    )
  }
  const eyebrow = "text-[10.5px] font-medium tracking-[0.13em] text-faint"
  return (
    <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby="session-commits">
      <div className="flex flex-col gap-0.5 px-3 py-2">
        <h3 id="session-commits" className={`m-0 ${eyebrow}`}>COMMITS</h3>
        <p className="m-0 text-[11px] text-muted-foreground">
          {pending ? `Committing on ${controls.machine}.` : "One commit of every change below, on the session branch. Edit the message, then commit."}
        </p>
      </div>
      <div className="border-t">
        <div className="flex items-center gap-2 px-3 pt-2.5 font-machine text-mono-xs text-faint">
          <span className="text-strong">1</span>
          <span>{totalFiles} {totalFiles === 1 ? "file" : "files"}</span>
        </div>
        <div className="px-3 pt-1.5 pb-2.5">
          <Textarea
            aria-label="Commit message"
            spellCheck={false}
            value={message}
            readOnly={pending}
            rows={2}
            className="min-h-0 font-machine text-[11.5px]"
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <ul aria-label="Files in this commit" className="m-0 list-none border-t p-0">
          {files.map((file) => (
            <li key={file.path} className="flex items-center gap-2 px-3 py-1.5 font-machine text-mono-xs">
              <span className="w-3 shrink-0 text-faint">{statusLetter[file.status]}</span>
              <span className="min-w-0 wrap-anywhere text-muted-foreground">{file.path}</span>
            </li>
          ))}
        </ul>
        {totalFiles > files.length ? (
          <p className="m-0 border-t px-3 py-1.5 font-machine text-mono-xs text-faint">
            and {totalFiles - files.length} more, all in this commit
          </p>
        ) : null}
      </div>
      <p className="m-0 border-t px-3 py-2 text-[11px] leading-normal text-muted-foreground">
        Built from the worktree as it is now. Your own checkout is never written, and nothing is pushed.
      </p>
      {controls.blocked !== undefined ? (
        <p className="m-0 border-t px-3 py-2 text-[11px] leading-normal text-muted-foreground">{controls.blocked}</p>
      ) : null}
      {error ? (
        <div className="border-t p-3">
          <Alert variant="destructive" aria-live="polite">
            <CircleStopIcon />
            <AlertTitle>Not committed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
        <Button size="xs" disabled={pending || controls.blocked !== undefined || !message.trim()} onClick={commit}>
          <GitCommitHorizontalIcon />
          {pending ? "Committing" : "Commit 1"}
        </Button>
        <Button variant="outline" size="xs" disabled={pending} onClick={onCancel}>Cancel</Button>
        <span className="flex-1" />
        <span className="font-machine text-mono-xs text-faint">git on {controls.machine}</span>
      </div>
    </section>
  )
}
