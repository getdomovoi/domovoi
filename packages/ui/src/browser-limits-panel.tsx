import { useEffect, useRef } from "react"

import { Button } from "./components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog"
import { cn } from "./lib/utils"
import { StatusDot, type StatusMeaning } from "./status-dot"

export type BrowserLimitTone = "same" | "conditional" | "refused" | "never"

export type BrowserLimit = {
  what: string
  state: string
  tone: BrowserLimitTone
  why: string
}

// The tone is a state a person acts on: same needs nothing, conditional has a
// step, refused was stopped by this browser, never is not this surface's job.
const meaningFor: Record<BrowserLimitTone, StatusMeaning> = {
  same: "online",
  conditional: "waiting",
  refused: "offline",
  never: "idle",
}

const stateTone: Record<BrowserLimitTone, string> = {
  same: "text-success",
  conditional: "text-warning",
  refused: "text-destructive",
  never: "text-muted-foreground",
}

const title = "What a browser tab can and cannot do"
const oneFact = "Each difference follows from one fact: no daemon, no repository, no keychain."

function LimitRows({ rows }: { rows: BrowserLimit[] }) {
  return (
    <ul aria-label="Browser limits" className="m-0 list-none divide-y divide-border rounded-xl border border-border p-0">
      {rows.map((row) => (
        // Three columns from sm up; on a phone the why takes its own line
        // under the what and the state, so no column is squeezed to nothing.
        <li key={row.what} data-tone={row.tone} className="flex flex-wrap items-start gap-x-3 gap-y-0.5 px-3.5 py-2.5 sm:flex-nowrap">
          <StatusDot meaning={meaningFor[row.tone]} label={row.state} labelHidden size="inline" className="mt-1.5" />
          <span className="min-w-0 flex-1 text-[12.5px] font-medium text-strong sm:w-40 sm:flex-none sm:shrink-0">{row.what}</span>
          <span className={cn("shrink-0 font-mono text-[10.5px] leading-5 sm:w-32", stateTone[row.tone])}>{row.state}</span>
          <span className="min-w-0 basis-full pl-5 text-[11.5px] leading-5 text-muted-foreground sm:basis-0 sm:flex-1 sm:pl-0">{row.why}</span>
        </li>
      ))}
    </ul>
  )
}

// Inside a session the same limits open as a dialog over the live session
// (Q99 A): a page drawn over a hidden session leaks that session's shortcuts,
// theme and open dialogs, and replacing the session drops an unsent prompt.
// A dialog stacks with the session's own dialogs, so Escape closes the
// topmost, and focus goes back to the control the caller names.
function BrowserLimitsDialog({ rows, onContinue, continueLabel, open, returnFocusTo }: {
  rows: BrowserLimit[]
  onContinue: () => void
  continueLabel: string
  open: boolean
  returnFocusTo: HTMLElement | null
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  // Set when focus left for another surface, which then keeps it.
  const leftForElsewhere = useRef(false)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onContinue() }}>
      <DialogContent
        data-browser-limits=""
        showCloseButton={false}
        className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          leftForElsewhere.current = false
          event.preventDefault()
          heading.current?.focus()
        }}
        // The session's palette can open over the dialog and take the session
        // somewhere else. Focus moving to another surface closes the limits;
        // that surface gives focus back on its own way out (the palette to
        // the control that opened the limits).
        onFocusOutside={() => {
          leftForElsewhere.current = true
          onContinue()
        }}
        onCloseAutoFocus={(event) => {
          if (leftForElsewhere.current) {
            event.preventDefault()
            return
          }
          if (!returnFocusTo?.isConnected) return
          event.preventDefault()
          returnFocusTo.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle asChild><h2 ref={heading} tabIndex={-1} className="outline-none">{title}</h2></DialogTitle>
          <DialogDescription>{oneFact}</DialogDescription>
        </DialogHeader>
        <LimitRows rows={rows} />
        <DialogFooter>
          <Button type="button" onClick={onContinue}>{continueLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The web design's third step. Everything a browser tab cannot do is stated
// here, once, before the person hits it inside the session. The rows are
// measured by the caller against this browser; this panel only says them.
// Opened from the connect page, before there is a session, the one way on is
// back to pairing, so the caller names it.
export function BrowserLimitsPanel({ rows, onContinue, continueLabel = "Continue to the session", dialog }: {
  rows: BrowserLimit[]
  onContinue: () => void
  continueLabel?: string
  // Present inside a session: the limits open as a dialog over it.
  dialog?: { open: boolean; returnFocusTo: HTMLElement | null } | undefined
}) {
  if (dialog) return <BrowserLimitsDialog rows={rows} onContinue={onContinue} continueLabel={continueLabel} open={dialog.open} returnFocusTo={dialog.returnFocusTo} />
  return <BrowserLimitsPage rows={rows} onContinue={onContinue} continueLabel={continueLabel} />
}

function BrowserLimitsPage({ rows, onContinue, continueLabel }: {
  rows: BrowserLimit[]
  onContinue: () => void
  continueLabel: string
}) {
  // The panel replaces the page it was opened from, so focus starts at its
  // heading rather than falling to the document body.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  return (
    // Full height comes from the page around it, under the Web v2 bar.
    <main className="flex min-h-0 flex-1 items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-2xl">
        {/* The Web v2 bar above carries the mark, so the card draws none. */}
        <CardHeader>
          <CardTitle asChild><h1 ref={heading} tabIndex={-1} className="outline-none">{title}</h1></CardTitle>
          <CardDescription>{oneFact}</CardDescription>
        </CardHeader>
        <CardContent>
          <LimitRows rows={rows} />
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="button" onClick={onContinue}>{continueLabel}</Button>
        </CardFooter>
      </Card>
    </main>
  )
}
