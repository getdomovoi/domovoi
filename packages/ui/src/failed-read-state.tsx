import { CircleStopIcon } from "lucide-react"
import { useId } from "react"

import { Button } from "./components/ui/button"
import { ThreadConnectionBanner } from "./connection-status"
import type { SessionReadAttempt, SessionReadFailure, SessionReadOutcome } from "./session-read"

// One line of WHAT IT TRIED. A failed step reads red and the closing line,
// which says what the client refused to do, reads green, as the design does.
export type FailedReadLogLine = { text: string, tone: "dim" | "fail" | "pass" }

const noPartialThread = "Domovoi will not show a partial thread, because a partial thread reads like a finished one."

// A timeout says only that no answer arrived in time: the request, the reply
// or the daemon's work on it may each be where it stopped.
function sessionReadMessage(outcome: SessionReadOutcome): string {
  switch (outcome.kind) {
    case "timeout": {
      const seconds = Math.round(outcome.timeoutMs / 1000)
      return `The daemon accepted the connection, but no answer to this read arrived within ${seconds} ${seconds === 1 ? "second" : "seconds"}. ${noPartialThread}`
    }
    case "closed": return `The connection to the daemon closed before it answered. ${noPartialThread}`
    case "unreadable": return `The daemon answered, but the answer could not be read. ${noPartialThread}`
  }
}

function sessionReadOutcomeLine(outcome: SessionReadOutcome): string {
  switch (outcome.kind) {
    case "timeout": return `no answer in ${Math.round(outcome.timeoutMs / 1000)}s`
    case "closed": return "the connection closed before an answer"
    case "unreadable": return "the answer could not be read"
  }
}

// This device's wall clock, as the person reads it, to the second.
function clock(at: Date): string {
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":")
}

export function sessionReadLog(recent: readonly SessionReadAttempt[], title: string): FailedReadLogLine[] {
  const lines = recent.flatMap((attempt): FailedReadLogLine[] => [
    { text: `${clock(attempt.startedAt)} read ${title}`, tone: "dim" },
    { text: `${clock(attempt.endedAt)} ${sessionReadOutcomeLine(attempt.outcome)}`, tone: "fail" },
  ])
  const last = recent.at(-1)
  if (last) lines.push({ text: `${clock(last.endedAt)} nothing rendered, no partial thread shown`, tone: "pass" })
  return lines
}

// What stays true when a session read fails: what the failed read cannot do,
// not a guess at the session's state now, which another client or the daemon
// may have moved on (Q111). session.activate writes only which session the
// daemon has open, and the daemon runs turns without any client. The design's
// third line, that any gate raised meanwhile is still waiting, is left out:
// another client can answer a gate while this one cannot read.
const sessionReadFacts = [
  "A failed read does not change or remove the session. Opening one changes only which session the daemon has open.",
  "A failed read does not stop a turn. The daemon does not need this window.",
]

// The thread column while the session a person asked for could not be read.
// It stands in for the thread rather than beside it, so the session that was
// open before is not left on screen under the one that was asked for. Opening
// a session writes the daemon's active session, so it makes no claim that
// nothing was written.
export function FailedSessionRead({
  failure,
  title,
  connected,
  onRetry,
  onOpenMachine,
}: {
  failure: SessionReadFailure
  title: string
  // Try again waits for an open connection: without one the read never
  // leaves this client.
  connected: boolean
  onRetry: () => void
  onOpenMachine?: (() => void) | undefined
}) {
  const last = failure.recent.at(-1)
  return (
    <main className="flex h-full min-w-0 flex-col bg-background">
      <ThreadConnectionBanner />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <FailedReadState
          message={last ? sessionReadMessage(last.outcome) : `The session could not be read. ${noPartialThread}`}
          attemptCount={failure.count}
          attempts={sessionReadLog(failure.recent, title)}
          facts={sessionReadFacts}
          retrying={failure.retrying}
          retryDisabled={!connected}
          onRetry={onRetry}
          onOpenMachine={onOpenMachine}
        />
      </div>
    </main>
  )
}

export function FailedReadState({
  message,
  attemptCount,
  attempts = [],
  facts,
  retrying,
  retryDisabled = false,
  retryLocked,
  retryError,
  onRetry,
  onOpenMachine,
  nothingWritten = false,
}: {
  message: string
  // How many reads this client sent and saw fail, when it counted them. A
  // failure nobody counted draws no number rather than an invented one.
  attemptCount?: number | undefined
  attempts?: readonly (string | FailedReadLogLine)[] | undefined
  facts: readonly string[]
  retrying: boolean
  retryDisabled?: boolean | undefined
  // Why this client cannot try again at all, said under the button.
  retryLocked?: string | undefined
  retryError?: string | undefined
  onRetry: () => void
  onOpenMachine?: (() => void) | undefined
  // True only for a failure that read and wrote nothing. A provider can write
  // files before it stops, so the surface makes no such claim by default.
  nothingWritten?: boolean | undefined
}) {
  const lockedId = useId()
  return (
    <section aria-label="Could not read this session" className="mx-auto flex w-full max-w-[620px] flex-col gap-4">
      <div className="overflow-hidden rounded-xl border border-danger-border bg-danger-background">
        <div className="flex items-center gap-3 px-4 py-3 text-danger-foreground">
          <span aria-hidden className="size-2 rounded-full bg-destructive" />
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Could not read this session</h2>
          {attemptCount !== undefined ? <span className="ml-auto font-machine text-[10.5px] text-danger-dim">{attemptCount === 1 ? "1 attempt" : `${attemptCount} attempts`}</span> : null}
        </div>
        <p className="m-0 px-4 pb-3 text-[13px] leading-relaxed text-danger-foreground">{message}</p>
      </div>
      {attempts.length > 0 ? (
        <div className="overflow-hidden rounded-xl border">
          <h3 className="m-0 border-b bg-card px-3.5 py-2.5 text-[10.5px] font-medium tracking-[0.13em] text-faint">WHAT IT TRIED</h3>
          {/* Two attempts in the same second write the same line, so the
              position is part of the key. */}
          <div className="flex flex-col bg-code px-3.5 py-3 font-machine text-[11px] leading-[1.8] text-muted-foreground">{attempts.map((attempt, index) => {
            const line = typeof attempt === "string" ? { text: attempt, tone: "dim" as const } : attempt
            return <span key={`${index}:${line.text}`} className={line.tone === "fail" ? "text-destructive" : line.tone === "pass" ? "text-success" : undefined}>{line.text}</span>
          })}</div>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-xl border">
        <h3 className="m-0 border-b bg-card px-3.5 py-2.5 text-[13px] font-semibold">What is still true</h3>
        <ul className="m-0 list-none p-0">
          {facts.map((fact) => (
            <li key={fact} className="flex items-start gap-2.5 border-t px-3.5 py-2.5 text-[12.5px] leading-relaxed text-strong first:border-t-0">
              <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" />
              {fact}
            </li>
          ))}
        </ul>
      </div>
      {retryError ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-background px-3 py-2 text-[12px] text-danger-foreground">
          <CircleStopIcon className="mt-0.5 size-4 shrink-0" />
          {retryError}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button disabled={retrying || retryDisabled || retryLocked !== undefined} aria-describedby={retryLocked !== undefined ? lockedId : undefined} onClick={() => { if (retryLocked === undefined) onRetry() }}>{retrying ? "Trying again…" : "Try again"}</Button>
        {onOpenMachine ? <Button variant="outline" onClick={onOpenMachine}>Open the machine</Button> : null}
        {nothingWritten ? <span className="ml-auto font-machine text-[10.5px] text-faint">nothing was written, nothing was lost</span> : null}
      </div>
      {retryLocked !== undefined ? <p id={lockedId} className="m-0 text-[12px] leading-relaxed text-muted-foreground">{retryLocked}</p> : null}
    </section>
  )
}
