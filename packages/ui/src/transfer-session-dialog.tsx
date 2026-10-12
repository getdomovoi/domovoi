import { useEffect, useId, useRef, useState } from "react"
import { CheckIcon, CircleStopIcon } from "lucide-react"

import {
  sessionTransferRefusalMessage,
  sourcePreflight,
  transferPreflight,
  type FleetHealth,
  type FleetMachine,
  type TransferRefusal,
  type SessionSummary,
  type SessionTransferParams,
  type SessionTransferPreview,
  type SessionTransferPreviewParams,
  type SessionTransferResult,
  type TransferMethod,
} from "@getdomovoi/protocol"

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert"
import { Button } from "./components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog"
import { Field, FieldLabel } from "./components/ui/field"
import { Input } from "./components/ui/input"

// These lists are prose, and prose is how a promise outruns the product: the
// earlier version claimed skills travelled and secrets did not, and neither was
// true. Keep every line checkable against what a transfer actually sends.
import { transferCoverageLists } from "./transfer-coverage.js"
import { returnTransferExplanation, transferOutcomeNotice } from "./transfer-outcome.js"

// Long enough that an ordinary remote name is typed in one go, short enough
// that the preview feels like an answer rather than a delay.
export const previewDebounceMs = 400

type TransferCheck = { label: string; ready: boolean }
type IncompleteTransfer = Extract<SessionTransferResult, { outcome: "incomplete" }>

export function transferChecks(input: {
  session: SessionSummary
  source: FleetMachine
  target: FleetMachine
}): TransferCheck[] {
  const source = sourcePreflight({ session: input.session })
  const target = transferPreflight({ source: input.source, target: input.target })
  return [
    {
      ready: source.allowed,
      label: source.allowed
        ? "This session is ready to move"
        : sessionTransferRefusalMessage(source.reason),
    },
    {
      ready: target.allowed,
      label: target.allowed
        ? `${input.target.label} can receive it`
        : sessionTransferRefusalMessage(target.reason),
    },
  ]
}

// The design's summary reads "6 pass · 1 warning". Every check this client can
// draw today stops the move when it fails, so a failure is counted as blocking
// rather than as a warning the operator could move past.
export function preflightSummary(checks: readonly TransferCheck[]): string {
  const blocking = checks.filter((check) => !check.ready).length
  const pass = `${checks.length - blocking} pass`
  return blocking === 0 ? pass : `${pass} · ${blocking} blocking`
}

// A row note says whether the machine could take the session right now. The
// fleet carries health and the route, not which providers are installed there,
// so the note stops at reachability.
const unavailableNote: Record<TransferRefusal, string> = {
  "target-is-source": "the session is already here",
  "target-unreachable": "daemon unreachable, cannot accept a session now",
  "target-not-responding": "not answering, cannot accept a session now",
  "target-pairing-required": "must be paired again before it can accept a session",
  "target-version-mismatch": "runs a newer Domovoi than this client can move a session to",
  "target-upgrade-required": "runs an older Domovoi and needs an upgrade first",
  "target-cannot-run-sessions": "does not run sessions",
}

const healthDot: Record<FleetHealth, string> = {
  healthy: "bg-success",
  reconnecting: "bg-warning",
  degraded: "bg-warning",
  "upgrade-required": "bg-warning",
  "credential-store-unavailable": "bg-warning",
  unreachable: "bg-destructive",
  "version-mismatch": "bg-destructive",
  "pairing-required": "bg-destructive",
}

function routeWord(machine: FleetMachine): string {
  if (machine.connection === "local") return "loopback"
  if (machine.connection === "direct" && machine.verifiedRoute) {
    return `a direct route to ${new URL(machine.verifiedRoute.endpoint).host}`
  }
  return machine.connection
}

export function transferTargetRow(input: { machine: FleetMachine; source: FleetMachine }): {
  available: boolean
  note: string
} {
  const { machine, source } = input
  const check = transferPreflight({ source, target: machine })
  if (check.allowed) {
    // Health says the machine answers the fleet, not that the daemon has a
    // route to dial for the move. With neither a verified route nor an
    // advertised transport the dial fails, so the row is not offered. A
    // verified route alone is enough: the daemon dials it first.
    if (!machine.verifiedRoute && machine.transports.length === 0) {
      return { available: false, note: "advertises no route to dial, cannot accept a session now" }
    }
    return { available: true, note: `reachable over ${routeWord(machine)}` }
  }
  if (check.reason === "target-is-source" && machine.self) {
    return { available: false, note: `this machine, ${unavailableNote[check.reason]}` }
  }
  // The preflight folds an unreadable keychain into unreachable. The daemon
  // there may be fine, so the row says which side failed.
  if (machine.health === "credential-store-unavailable") {
    return { available: false, note: "the keychain here could not be read, cannot reach it now" }
  }
  return { available: false, note: unavailableNote[check.reason] }
}

function TargetList({
  machines,
  source,
  target,
  disabled,
  onPick,
}: {
  machines: readonly FleetMachine[]
  source: FleetMachine
  target: FleetMachine
  disabled: boolean
  onPick: (machineId: string) => void
}) {
  const name = useId()
  return (
    <div role="radiogroup" aria-labelledby="transfer-target-title" className="flex flex-col gap-2">
      {machines.map((machine) => {
        const row = transferTargetRow({ machine, source })
        const chosen = machine.id === target.id
        const off = disabled || !row.available
        return (
          <label
            key={machine.id}
            className={`flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${chosen ? "border-primary" : ""} ${off ? "opacity-50" : ""} ${off || chosen ? "cursor-default" : "cursor-pointer hover:bg-accent"}`}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={chosen}
              disabled={off}
              aria-labelledby={`${name}-${machine.id}-label`}
              aria-describedby={`${name}-${machine.id}-note`}
              onChange={() => onPick(machine.id)}
            />
            <span className={`size-1.5 shrink-0 rounded-full ${healthDot[machine.health]}`} />
            <span className="min-w-0 flex-1">
              <span id={`${name}-${machine.id}-label`} className="block font-machine text-[12px]">{machine.label}</span>
              <span id={`${name}-${machine.id}-note`} className="mt-0.5 block text-[11px] text-muted-foreground">{row.note}</span>
            </span>
            <CheckIcon className={`size-4 shrink-0 ${chosen ? "text-primary" : "text-transparent"}`} />
          </label>
        )
      })}
    </div>
  )
}

function FixedList({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <div role="group" aria-label={label} className="min-w-0 flex-1">
      <p className="m-0 text-[12px] font-semibold">{label}</p>
      <ul className="mt-1.5 m-0 list-none p-0 text-[12px] leading-relaxed text-muted-foreground">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  )
}

export function TransferSessionDialog({
  open,
  onOpenChange,
  session,
  source,
  target,
  onPreview,
  onTransfer,
  onTransferred,
  onOutcome,
  onRecoverSource,
  onCloseAutoFocus,
  targetChoice,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: SessionSummary
  source: FleetMachine
  target: FleetMachine
  onPreview: (
    params: Omit<SessionTransferPreviewParams, "initiatedByClient">,
  ) => Promise<SessionTransferPreview>
  onTransfer: (
    params: Omit<SessionTransferParams, "initiatedByClient">,
  ) => Promise<SessionTransferResult>
  onTransferred: (machineId: string) => void
  onOutcome: (result: SessionTransferResult) => void
  onRecoverSource?: ((transferId: string) => Promise<void>) | undefined
  // Where focus goes when the dialog closes, for an opener that cannot take
  // it back.
  onCloseAutoFocus?: ((event: Event) => void) | undefined
  // The fleet to pick from, with the source among it. The opener owns the
  // chosen target, so picking a row asks it to change rather than switching
  // here; a receipt it writes then names the machine the move went to. The
  // two travel together: a list nothing can pick from would draw choices
  // that do nothing. Without them the dialog draws the chosen machine alone.
  targetChoice?: {
    machines: readonly FleetMachine[]
    onTargetChange: (machineId: string) => void
  } | undefined
}) {
  const [method, setMethod] = useState<TransferMethod>("git-bundle")
  const [remote, setRemote] = useState("")
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<{ title: string; detail: string; from: "preview" | "move" } | undefined>(undefined)
  const [answered, setAnswered] = useState<{ key: string; preview: SessionTransferPreview } | undefined>(undefined)
  const [previewing, setPreviewing] = useState(false)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [incomplete, setIncomplete] = useState<IncompleteTransfer | undefined>(undefined)
  const [recovering, setRecovering] = useState(false)

  // A preview answers one question: this session, to this machine, this way.
  // Any change to those asks a new one, and until it lands the old answer is
  // not this move's, even while a typed remote waits out its debounce. Keyed
  // here rather than cleared in an effect, so no render offers the move on it.
  const previewKey = JSON.stringify([session.id, target.id, method, method === "remote-ref" ? remote.trim() : null])
  const preview = answered?.key === previewKey ? answered.preview : undefined

  // The daemon decides what this move would carry and whether it may happen at
  // all. Asking it is not a nicety: session.transfer refuses anything without
  // the contract version and intent digest this call returns.
  useEffect(() => {
    if (!open) return
    let active = true
    // A preview is not a cheap read: it collects portable state, fingerprints
    // the repository and calls the target. Typing a remote name would run one
    // per keystroke, so the request waits for the typing to stop.
    if (method === "remote-ref" && !remote.trim()) {
      setAnswered(undefined)
      setPreviewing(false)
      return
    }
    const run = () => {
      setPreviewing(true)
      setAnswered(undefined)
      void onPreview({
        sessionId: session.id,
        targetMachineId: target.id,
        method,
        ...(method === "remote-ref" ? { remote: remote.trim() } : {}),
      }).then(
        (next) => {
          if (!active) return
          setAnswered({ key: previewKey, preview: next })
          // A preview that failed and then succeeded has nothing left to report,
          // so its error goes. A refused move stays: the operator asked for it
          // and the answer is what they are waiting to read.
          setProblem((current) => current?.from === "preview" ? undefined : current)
        },
        (cause: unknown) => {
          if (!active) return
          setProblem({
            title: "The move could not be previewed",
            detail: cause instanceof Error ? cause.message : `${source.label} did not answer.`,
            from: "preview",
          })
        },
      ).finally(() => { if (active) setPreviewing(false) })
    }
    // Only the typed remote needs waiting on. Opening the dialog, or switching
    // method, is a settled intent and asks at once.
    if (method !== "remote-ref") {
      run()
      return () => { active = false }
    }
    const timer = setTimeout(run, previewDebounceMs)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [method, onPreview, open, previewAttempt, previewKey, remote, session.id, source.label, target.id])

  // What the move carries is the daemon's answer, so it is read off the preview
  // rather than described here. Before the preview lands there is nothing
  // truthful to list, and the move is refused without it anyway.
  const coverage = preview ? transferCoverageLists(preview.coverage) : undefined

  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) {
      setMethod("git-bundle")
      setRemote("")
      setProblem(undefined)
      setAnswered(undefined)
      setIncomplete(undefined)
      setRecovering(false)
    }
    wasOpen.current = open
  }, [open])

  const checks = transferChecks({ session, source, target })
  // The design asks for a reachable machine instead of naming one the move
  // cannot reach, but only where the list offers one to pick.
  const pickAnother = targetChoice !== undefined
    && !transferTargetRow({ machine: target, source }).available
    && targetChoice.machines.some((machine) => transferTargetRow({ machine, source }).available)
  const pickTarget = (machineId: string) => {
    if (!targetChoice || machineId === target.id) return
    // A refusal or failure read for the previous machine says nothing about
    // this one.
    setProblem(undefined)
    targetChoice.onTargetChange(machineId)
  }
  const remoteReady = method === "git-bundle" || remote.trim().length > 0
  const ready = checks.every((check) => check.ready)
    && remoteReady
    && !pending
    && !previewing
    && preview?.allowed === true

  const recoverSource = async () => {
    if (!incomplete || !onRecoverSource || recovering) return
    setRecovering(true)
    setProblem(undefined)
    try {
      await onRecoverSource(incomplete.transferId)
      onOpenChange(false)
    } catch (cause) {
      setProblem({ title: "Source recovery did not finish", detail: cause instanceof Error ? cause.message : `The session remains frozen on ${source.label}.`, from: "move" })
    } finally {
      setRecovering(false)
    }
  }

  const move = async () => {
    if (!ready) return
    setPending(true)
    setProblem(undefined)
    try {
      if (!preview?.allowed) return
      const result = await onTransfer({
        // Copied from the preview rather than composed here: the digest is the
        // daemon's promise about what it inspected, and a value this client
        // assembled would bind nothing.
        contractVersion: preview.contractVersion,
        intentDigest: preview.intentDigest,
        sessionId: session.id,
        targetMachineId: target.id,
        method,
        ...(method === "remote-ref" ? { remote: remote.trim() } : {}),
      })
      onOutcome(result)
      setIncomplete(result.outcome === "incomplete" ? result : undefined)
      if (result.outcome === "succeeded") {
        onTransferred(target.id)
        onOpenChange(false)
        return
      }
      if (result.outcome === "refused") {
        const returning = returnTransferExplanation(
          session.transferredFrom?.sourceMachineId,
          target.id,
          target.label,
        )
        setProblem({
          title: "Session did not move",
          detail: [sessionTransferRefusalMessage(result.reason), returning]
            .filter((part) => part !== undefined)
            .join(" "),
          from: "move",
        })
      } else {
        setProblem({ ...transferOutcomeNotice(result, source.label), from: "move" })
      }
      // The digest describes a session that has since moved on, so the refusal
      // is answered by asking again rather than by making the operator close
      // the dialog and reopen it to get a digest the daemon will accept.
      if (result.outcome === "refused" && result.reason === "session-state-changed") {
        setPreviewAttempt((attempt) => attempt + 1)
      }
    } catch (cause) {
      setProblem({
        title: "Session did not move",
        detail: cause instanceof Error ? cause.message : `The session stayed on ${source.label}.`,
        from: "move",
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[620px]" {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}>
        <DialogHeader>
          <DialogTitle>Move this session to another machine</DialogTitle>
          <DialogDescription>
            The thread, the plan and the worktree are recreated on the target. Running processes are not moved, and the agent starts its next turn there from a clean checkout of the same branch.
          </DialogDescription>
        </DialogHeader>

        {problem ? (
          <Alert variant="destructive">
            <CircleStopIcon />
            <AlertTitle>{problem.title}</AlertTitle>
            <AlertDescription>{problem.detail}</AlertDescription>
          </Alert>
        ) : null}

        <section className="flex flex-col gap-2" aria-labelledby="transfer-target-title">
          <h3 id="transfer-target-title" className="m-0 text-[10.5px] font-medium tracking-[0.13em] text-faint">TARGET</h3>
          {targetChoice ? (
            <TargetList
              machines={targetChoice.machines}
              source={source}
              target={target}
              disabled={pending || incomplete !== undefined}
              onPick={pickTarget}
            />
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-primary bg-card px-3 py-2.5"><span className={`size-1.5 rounded-full ${healthDot[target.health]}`} /><span className="flex-1 font-machine text-[12px]">{target.label}</span><CheckIcon className="size-4 text-primary" /></div>
          )}
        </section>

        <div className="flex items-center gap-2"><h3 className="m-0 text-[10.5px] font-medium tracking-[0.13em] text-faint">PRE-FLIGHT ON {target.label.toUpperCase()}</h3><span className="rounded-full bg-accent px-2 py-0.5 font-machine text-[10.5px] text-muted-foreground">{preflightSummary(checks)}</span></div>
        <div role="group" aria-label="Transfer checks" className="overflow-hidden rounded-lg border">
          {checks.map((check) => (
            <p
              key={check.label}
              className={`m-0 flex items-start gap-2.5 border-t px-3 py-2 first:border-t-0 text-[11.5px] ${check.ready ? "text-muted-foreground" : "text-destructive"}`}
            >
              {check.ready ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" /> : <CircleStopIcon className="mt-0.5 size-3.5 shrink-0" />}
              {check.label}
            </p>
          ))}
        </div>

        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="text-[12px] font-semibold">How the repository travels</legend>
          <label className="flex items-start gap-2 text-[12px]">
            <input
              type="radio"
              name="transfer-method"
              className="mt-0.5"
              checked={method === "git-bundle"}
              disabled={pending}
              onChange={() => setMethod("git-bundle")}
            />
            <span>
              Git bundle
              <span className="block text-muted-foreground">
                Repository bytes go straight to {target.label} and touch nothing else.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-[12px]">
            <input
              type="radio"
              name="transfer-method"
              className="mt-0.5"
              checked={method === "remote-ref"}
              disabled={pending}
              onChange={() => setMethod("remote-ref")}
            />
            <span>
              Remote ref
              <span className="block text-muted-foreground">
                A Domovoi ref is pushed to a remote you name, and {target.label} fetches it.
              </span>
            </span>
          </label>
        </fieldset>

        {method === "remote-ref" ? (
          <Field>
            <FieldLabel htmlFor="transfer-remote">Remote name</FieldLabel>
            <Input
              id="transfer-remote"
              value={remote}
              disabled={pending}
              placeholder="origin"
              className="font-machine"
              onChange={(event) => setRemote(event.target.value)}
            />
          </Field>
        ) : null}

        {coverage ? (
          <>
            <div className="flex flex-col gap-4 sm:flex-row">
              <FixedList label="Travels with the session" items={coverage.included} />
              <FixedList label="Does not travel" items={coverage.excluded} />
            </div>

            {coverage.warnings.map((warning) => (
              <p key={warning} className="m-0 text-[11px] leading-relaxed text-warning">{warning}</p>
            ))}
            <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">
              Not sent either way: shell history, background processes, anything written outside the worktree, and credentials. The target authenticates its own providers.
            </p>
          </>
        ) : (
          <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">
            {previewing
              ? `Asking ${source.label} what this move would carry`
              : `${source.label} has not said what this move would carry`}
          </p>
        )}

        {incomplete ? (
          <section role="region" aria-label="Half-failed move" className="flex flex-col gap-3 rounded-xl border p-3">
            <div><h3 className="m-0 text-[13px] font-semibold">Half-failed move</h3><p className="mt-1 text-[11.5px] leading-[1.55] text-muted-foreground">The source remains authoritative unless the daemon confirms otherwise. Nothing here deletes either worktree.</p></div>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border">
              <div className="bg-card p-3"><div className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-success" /><span className="font-machine text-[11.5px]">{source.label}</span></div><p className="mb-0 mt-2 text-[11px] text-muted-foreground">source · recovery checkpoint kept</p></div>
              <div className="bg-card p-3"><div className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-warning" /><span className="font-machine text-[11.5px]">{target.label}</span></div><p className="mb-0 mt-2 text-[11px] text-muted-foreground">target · {incomplete.state}</p></div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={!onRecoverSource || recovering} onClick={() => void recoverSource()}>{recovering ? "Recovering source" : "Recover the source and keep working here"}</Button>
              <Button variant="outline" disabled={pending || previewing} onClick={() => { setIncomplete(undefined); setProblem(undefined); setPreviewAttempt((attempt) => attempt + 1) }}>Retry the move</Button>
              <span className="ml-auto font-machine text-[10.5px] text-faint">doing nothing is safe, the lease expires</span>
            </div>
          </section>
        ) : null}

        {preview?.allowed === false ? (
          <Alert variant="destructive">
            <CircleStopIcon />
            <AlertTitle>This move is refused</AlertTitle>
            <AlertDescription>
              {[
                sessionTransferRefusalMessage(preview.reason),
                returnTransferExplanation(
                  session.transferredFrom?.sourceMachineId,
                  target.id,
                  target.label,
                ),
              ].filter((part) => part !== undefined).join(" ")}
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!incomplete ? <Button type="button" aria-label="Move session" disabled={!ready} onClick={() => void move()}>
            {pending ? "Moving session" : pickAnother ? "Pick a reachable machine" : `Move to ${target.label}`}
          </Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
