import { useEffect, useRef, useState } from "react"
import { CheckIcon, CircleStopIcon } from "lucide-react"

import {
  sessionTransferRefusalMessage,
  sourcePreflight,
  transferPreflight,
  type FleetMachine,
  type SessionSummary,
  type SessionTransferParams,
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
const travelsWithSession = [
  "Thread",
  "Plan",
  "Tool and test results",
  "Annotations",
  "Permission mode",
  "Tracked changes",
  "Non-ignored untracked files",
] as const

const staysBehind = [
  "Running dev servers and PTYs, which restart there",
  "Provider credentials",
  "Skills enabled for this project, which are reviewed again there",
  "Standing approval rules, which are approved again there",
  "Ignored files, including ignored build output",
] as const

// A checkpoint commits with `git add --all`, so anything tracked or not ignored
// travels whatever it is called. Saying "secrets stay behind" was false.
const transferCaveat = "A tracked or non-ignored file travels regardless of its name, including a committed .env or database file. Only ignored files stay behind."

type TransferCheck = { label: string; ready: boolean }

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
  onTransfer,
  onTransferred,
  onOutcome,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: SessionSummary
  source: FleetMachine
  target: FleetMachine
  onTransfer: (
    params: Omit<SessionTransferParams, "client">,
  ) => Promise<SessionTransferResult>
  onTransferred: (machineId: string) => void
  onOutcome: (result: SessionTransferResult) => void
}) {
  const [method, setMethod] = useState<TransferMethod>("git-bundle")
  const [remote, setRemote] = useState("")
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState("")

  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) {
      setMethod("git-bundle")
      setRemote("")
      setProblem("")
    }
    wasOpen.current = open
  }, [open])

  const checks = transferChecks({ session, source, target })
  const remoteReady = method === "git-bundle" || remote.trim().length > 0
  const ready = checks.every((check) => check.ready) && remoteReady && !pending

  const move = async () => {
    if (!ready) return
    setPending(true)
    setProblem("")
    try {
      const result = await onTransfer({
        sessionId: session.id,
        targetMachineId: target.id,
        method,
        ...(method === "remote-ref" ? { remote: remote.trim() } : {}),
      })
      onOutcome(result)
      if (result.outcome === "succeeded") {
        onTransferred(target.id)
        onOpenChange(false)
        return
      }
      setProblem(result.outcome === "refused"
        ? sessionTransferRefusalMessage(result.reason)
        : `The session did not move and stayed on ${source.label}`)
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : `The session did not move and stayed on ${source.label}`)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Move session to {target.label}</DialogTitle>
          <DialogDescription>
            The worktree is checkpointed here first, so this machine keeps a recovery point either way.
          </DialogDescription>
        </DialogHeader>

        {problem ? (
          <Alert variant="destructive">
            <CircleStopIcon />
            <AlertTitle>Session did not move</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}

        <div role="group" aria-label="Transfer checks" className="flex flex-col gap-1">
          {checks.map((check) => (
            <p
              key={check.label}
              className={`m-0 flex items-start gap-1.5 text-[12px] ${check.ready ? "text-muted-foreground" : "text-destructive"}`}
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

        <div className="flex flex-col gap-4 sm:flex-row">
          <FixedList label="Travels with the session" items={travelsWithSession} />
          <FixedList label="Does not travel" items={staysBehind} />
        </div>

        <p className="m-0 text-[11px] leading-relaxed text-warning">{transferCaveat}</p>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!ready} onClick={() => void move()}>
            {pending ? "Moving session" : "Move session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
