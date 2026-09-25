import { CircleStopIcon } from "lucide-react"

import { Button } from "./components/ui/button"

export function FailedReadState({
  message,
  attempts = [],
  facts,
  retrying,
  retryDisabled = false,
  retryError,
  onRetry,
  onOpenMachine,
}: {
  message: string
  attempts?: readonly string[] | undefined
  facts: readonly string[]
  retrying: boolean
  retryDisabled?: boolean | undefined
  retryError?: string | undefined
  onRetry: () => void
  onOpenMachine?: (() => void) | undefined
}) {
  return (
    <section aria-label="Could not read this session" className="mx-auto flex w-full max-w-[620px] flex-col gap-4">
      <div className="overflow-hidden rounded-xl border border-danger-border bg-danger-background">
        <div className="flex items-center gap-3 px-4 py-3 text-danger-foreground">
          <span aria-hidden className="size-2 rounded-full bg-destructive" />
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">Could not read this session</h2>
        </div>
        <p className="m-0 px-4 pb-3 text-[13px] leading-relaxed text-danger-foreground">{message}</p>
      </div>
      {attempts.length > 0 ? (
        <div className="overflow-hidden rounded-xl border">
          <h3 className="m-0 border-b bg-card px-3.5 py-2.5 text-[10.5px] font-medium tracking-[0.13em] text-faint">WHAT IT TRIED</h3>
          <div className="flex flex-col bg-code px-3.5 py-3 font-machine text-[11px] leading-[1.8] text-muted-foreground">{attempts.map((attempt) => <span key={attempt}>{attempt}</span>)}</div>
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
        <Button disabled={retrying || retryDisabled} onClick={onRetry}>{retrying ? "Trying again…" : "Try again"}</Button>
        {onOpenMachine ? <Button variant="outline" onClick={onOpenMachine}>Open the machine</Button> : null}
        <span className="ml-auto font-machine text-[10.5px] text-faint">nothing was written, nothing was lost</span>
      </div>
    </section>
  )
}
