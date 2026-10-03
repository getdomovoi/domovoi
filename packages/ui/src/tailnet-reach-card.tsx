import type { TailnetListenerStatus } from "@getdomovoi/protocol"
import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "./components/ui/button"
import { Switch } from "./components/ui/switch"
import {
  parseTailnetReachOutcome,
  parseTailnetReachReport,
  type TailnetReachOutcome,
  type TailnetReachReport,
  type TailnetReachStep,
} from "./tailnet-reach.js"

// TailnetReach (Q404 A, J25), the card from TailnetReach in the v2 handoff:
// "Reach this machine from my tailnet". It draws what the desktop answers
// about the switch and what the daemon answers about its tailnet listener
// (tailnet.status), and nothing it cannot know. One request runs a whole
// change, so while it runs the steps are listed in order without claiming
// which one is under way; afterwards the answer names where it stopped.

export type TailnetReachSource = {
  act(action: "status" | "on" | "off"): Promise<unknown>
  // The daemon's tailnet.status. Absent, the card draws the switch alone.
  listener?: (() => Promise<TailnetListenerStatus>) | undefined
  // The daemon runs inside this app (it restarts in place) rather than as
  // the login service (it restarts through the service update).
  inApp: boolean
}

type Direction = "on" | "off"
type Failure = Extract<TailnetReachOutcome, { ok: false }>

export type TailnetReachController = {
  report: TailnetReachReport | undefined
  readError: string | undefined
  listener: TailnetListenerStatus | undefined
  running: { direction: Direction; renew: boolean } | undefined
  failure: { direction: Direction; outcome: Failure } | undefined
  inApp: boolean
  check(): void
  turnOn(): Promise<TailnetReachOutcome | undefined>
  turnOff(): Promise<TailnetReachOutcome | undefined>
  // "Go to the tailnet setting": counts requests, so the card scrolls itself
  // into view and marks itself for a moment on each one.
  revealed: number
  reveal(): void
}

// How often an open card reads the switch and tailnet.status again.
const tailnetReachRereadMs = 60_000
// How long an automatic read waits for the desktop's status before it counts
// as unanswered: the workspace's request budget for the daemon half
// (use-workspace.ts requestMs), so neither half holds the next read longer.
export const tailnetReachDesktopDeadlineMs = 120_000

// A source call as a promise, even when it throws instead of answering.
function attempt<T>(run: () => Promise<T>): Promise<T> {
  try { return Promise.resolve(run()) } catch (cause) { return Promise.reject(cause) }
}

// One controller serves the Settings card and the pairing card, so both draw
// the same switch. The source object may be rebuilt on every render; only
// whether there is one decides when to read.
export function useTailnetReach(source: TailnetReachSource | undefined): TailnetReachController | undefined {
  const sourceRef = useRef(source)
  sourceRef.current = source
  const [report, setReport] = useState<TailnetReachReport>()
  const [readError, setReadError] = useState<string>()
  const [listener, setListener] = useState<TailnetListenerStatus>()
  const [running, setRunning] = useState<TailnetReachController["running"]>()
  const [failure, setFailure] = useState<TailnetReachController["failure"]>()
  const [revealed, setRevealed] = useState(0)
  const reading = useRef(0)
  // The desktop's status call still pending, if any. Off, each one runs
  // tailscale status, so an automatic read shares a pending one instead of
  // starting another; an explicit check starts its own.
  const pending = useRef<Promise<unknown>>(undefined)
  const status = useCallback((current: TailnetReachSource, shared: boolean): Promise<unknown> => {
    if (shared && pending.current) return pending.current
    const call = attempt(() => current.act("status"))
    pending.current = call
    const settled = () => { if (pending.current === call) pending.current = undefined }
    call.then(settled, settled)
    return call
  }, [])

  // Each answer is drawn as it arrives: a daemon slow to answer tailnet.status
  // does not hold back the desktop's switch. A restarted daemon answers it
  // once its client reconnects. desktop settles with the desktop's answer or
  // failure, listened once tailnet.status has answered or failed. An automatic
  // read's desktop half also settles at the deadline, as a failure; the
  // desktop's answer is still drawn if it arrives before the next read.
  const read = useCallback((automatic = false): { desktop: Promise<void>; listened: Promise<void> } => {
    const current = sourceRef.current
    if (!current) return { desktop: Promise.resolve(), listened: Promise.resolve() }
    const request = ++reading.current
    const listened = current.listener
      ? attempt(current.listener).then((value) => { if (request === reading.current) setListener(value) }, () => { if (request === reading.current) setListener(undefined) })
      : Promise.resolve()
    const failed = (cause: unknown) => { if (request === reading.current) setReadError(cause instanceof Error ? cause.message : "The desktop did not answer.") }
    const answered = status(current, automatic).then(parseTailnetReachReport).then(
      (answer) => { if (request === reading.current) { setReport(answer); setReadError(undefined) } },
      failed,
    )
    const desktop = automatic
      ? new Promise<void>((resolve) => {
        const deadline = setTimeout(() => { failed(undefined); resolve() }, tailnetReachDesktopDeadlineMs)
        void answered.then(() => { clearTimeout(deadline); resolve() })
      })
      : answered
    return { desktop, listened }
  }, [status])

  // Review of PR #713 (P2): the switch and the listener also change on their
  // own, with Settings open: a renewal fails, or the daemon refuses the
  // tailnet listener at the certificate's expiry. Both are read again when the
  // window is focused or shown again, and every minute while it is shown, but
  // not while a change runs, which reads them once it ends.
  //
  // Codex review round 5 (P3): off, each desktop read runs tailscale status.
  // These reads, and the first, run one at a time until both answers are in or
  // failed; what comes in meanwhile is one more read after it, if the window
  // is still shown and no change runs by then.
  //
  // Codex review round 7 (P3): the desktop half is bounded by its deadline,
  // after which the next read goes ahead, reading the listener again and
  // sharing the desktop's pending answer.
  const changing = useRef(false)
  const automatic = useRef({ running: false, again: false })
  const readOnItsOwn = useCallback((first = false): void => {
    if (!first && (document.visibilityState !== "visible" || changing.current)) return
    const state = automatic.current
    if (state.running) {
      state.again = true
      return
    }
    state.running = true
    const done = () => {
      state.running = false
      if (!state.again) return
      state.again = false
      readOnItsOwn()
    }
    const { desktop, listened } = read(true)
    Promise.all([desktop, listened]).then(done, done)
  }, [read])

  const present = source !== undefined
  useEffect(() => { if (present) readOnItsOwn(true) }, [present, readOnItsOwn])

  useEffect(() => {
    if (!present || typeof document === "undefined") return
    const again = () => readOnItsOwn()
    window.addEventListener("focus", again)
    document.addEventListener("visibilitychange", again)
    const timer = setInterval(again, tailnetReachRereadMs)
    return () => {
      window.removeEventListener("focus", again)
      document.removeEventListener("visibilitychange", again)
      clearInterval(timer)
    }
  }, [present, readOnItsOwn])

  const change = useCallback(async (direction: Direction): Promise<TailnetReachOutcome | undefined> => {
    const current = sourceRef.current
    if (!current) return undefined
    changing.current = true
    setFailure(undefined)
    setRunning({ direction, renew: direction === "on" && report?.state === "on" })
    let outcome: TailnetReachOutcome
    try {
      outcome = parseTailnetReachOutcome(await current.act(direction))
    } catch (cause) {
      outcome = { ok: false, reason: "failed", step: direction === "on" ? "status" : "delete", message: cause instanceof Error ? cause.message : "The desktop did not answer." }
    }
    if (outcome.ok) setReport(outcome.report)
    else setFailure({ direction, outcome })
    await read().desktop
    changing.current = false
    setRunning(undefined)
    return outcome
  }, [read, report?.state])

  const check = useCallback(() => { setFailure(undefined); read() }, [read])
  const turnOn = useCallback(() => change("on"), [change])
  const turnOff = useCallback(() => change("off"), [change])
  const reveal = useCallback(() => setRevealed((count) => count + 1), [])
  if (!source) return undefined
  return { report, readError, listener, running, failure, inApp: source.inApp, check, turnOn, turnOff, revealed, reveal }
}

const title = "Reach this machine from my tailnet"
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// The design's "20 Dec 2026", in this computer's time zone.
function day(iso: string): string {
  const date = new Date(iso)
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`
}

function moment(iso: string): string {
  const date = new Date(iso)
  return `${date.getDate()} ${months[date.getMonth()]} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

type StepRow = { step: TailnetReachStep; label: string; mono: string }
type Row = { label: string; mono: string; state: "" | "done" | "failed" | "not run" }

function Steps({ rows, busy }: { rows: Row[]; busy: boolean }) {
  return (
    <ol className="m-0 flex list-none flex-col overflow-hidden rounded-[calc(var(--radius)-3px)] border bg-background p-0">
      {rows.map((row, index) => (
        <li key={row.label} className={`flex items-start gap-2.5 px-3 py-2.5 ${index ? "border-t" : ""}`}>
          <span aria-hidden className={`mt-[5px] size-[7px] shrink-0 rounded-full ${row.state === "done" ? "bg-success" : row.state === "failed" ? "bg-destructive" : busy ? "bg-primary" : "bg-faint"}`} />
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className={`text-[11.5px] leading-[1.5] ${row.state === "not run" ? "text-muted-foreground" : "text-foreground"}`}>{row.label}</span>
            <span className="font-machine text-[10.5px] break-all text-muted-foreground">{row.mono}</span>
          </span>
          {row.state ? <span className={`shrink-0 font-machine text-[10.5px] ${row.state === "failed" ? "text-destructive" : row.state === "done" ? "text-success" : "text-faint"}`}>{row.state}</span> : null}
        </li>
      ))}
    </ol>
  )
}

function Alert({ heading, body, mono, action, onAction, after }: { heading: string; body: string; mono?: string | undefined; action?: string; onAction?: () => void; after?: string | undefined }) {
  return (
    <div role="alert" className="flex flex-col gap-1.5 rounded-[calc(var(--radius)-3px)] border border-danger-border bg-danger-background px-[13px] py-3 text-danger-foreground">
      <span className="text-[12.5px] font-medium">{heading}</span>
      <span className="text-[11.5px] leading-[1.55]">{body}</span>
      {mono ? <span className="font-machine text-[10.5px] break-all opacity-80">{mono}</span> : null}
      {action || after ? (
        <div className="mt-[3px] flex flex-wrap items-center gap-2.5">
          {action && onAction ? <Button type="button" variant="outline" size="sm" className="border-danger-border text-danger-foreground" onClick={onAction}>{action}</Button> : null}
          {after ? <span className="text-[11px] leading-[1.5]">{after}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

export function TailnetReachCard({ controller, inCard = false }: { controller: TailnetReachController; inCard?: boolean }) {
  const { report, readError, listener, running, failure, inApp } = controller
  const ref = useRef<HTMLElement>(null)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (!controller.revealed) return
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "center" })
    setFlash(true)
    const timer = setTimeout(() => setFlash(false), 1_600)
    return () => clearTimeout(timer)
  }, [controller.revealed])

  const named = report && report.state !== "none" ? report : undefined
  const name = named?.name ?? "this machine's name"
  const tailnet = name.split(".").slice(1).join(".")
  const restart = inApp ? "the daemon inside this app restarts" : "the login service is updated and restarted"
  const store = named?.stored ?? "the Domovoi profile"
  const onSteps: StepRow[] = [
    { step: "status", label: "Read the tailnet status", mono: "tailscale status --json · reads only" },
    { step: "certificate", label: "Ask Tailscale for a certificate for this machine's own name", mono: `tailscale cert ${name}` },
    { step: "store", label: "Store the certificate and key in the Domovoi profile", mono: store },
    { step: "restart", label: "Restart the service so it answers on the tailnet", mono: restart },
  ]
  const offSteps: StepRow[] = [
    { step: "delete", label: "Delete the certificate and key from the Domovoi profile", mono: store },
    { step: "restart", label: "Restart the service on this computer only", mono: restart },
  ]

  // Where a failed change stopped: the steps before it done, it failed, the
  // rest not run. A refusal ran none of them, so it lists none. Codex review
  // round 6 (P3-2): a deletion that left files in a directory is not done.
  const failedRows = failure && failure.outcome.reason !== "refused" && failure.outcome.reason !== "busy"
    ? (() => {
        const { outcome } = failure
        const list = failure.direction === "on" ? onSteps : offSteps
        const at = Math.max(0, list.findIndex((row) => row.step === outcome.step))
        return list.map((row, index): Row => ({
          label: row.label, mono: row.mono,
          state: index < at ? (row.step === "delete" && outcome.undeleted ? "failed" : "done") : index === at ? "failed" : "not run",
        }))
      })()
    : undefined
  const httpsOff = failure?.outcome.reason === "https-off"
  const isOn = report?.state === "on"
  const expiry = listener?.state === "listening" ? listener.certificateExpiresAt : named?.certificateExpiresAt
  const renewalFailed = isOn ? named?.renewalFailed : undefined
  // The switch on is not the daemon listening (review of 049b1383, P2-3): only
  // tailnet.status says that. Known and not listening is not answering; not
  // known is said as not known, and reach is claimed only while listening.
  const listening = listener?.state === "listening"
  const notAnswering = isOn && listener !== undefined && !listening
  const refusedListener = isOn && listener?.state === "refused" ? listener : undefined
  const unconfirmed = isOn && listener === undefined
  // Re-review of 10dba4a2 (P3-2): off here, yet the daemon still listens, as
  // after a turn-on that ended with the service installed but not reached.
  const stillAnswering = report?.state === "off" && listening
  const stoppedOn = failure?.direction === "on" && !isOn

  const [tone, label] = running
    ? ["bg-primary", running.direction === "off" ? "Turning off" : running.renew ? "Renewing" : "Turning on"]
    : stoppedOn ? ["bg-destructive", "Stopped"]
      : !report ? ["bg-faint", readError ? "Not known" : "Reading"]
        : report.state === "none" ? ["bg-faint", "No tailnet"]
          : stillAnswering ? ["bg-destructive", "Still answering"]
          : report.state === "off" ? ["bg-faint", "Off"]
            : notAnswering ? ["bg-destructive", "Not answering"]
              : renewalFailed ? ["bg-destructive", "Renewal failed"]
                : [unconfirmed ? "bg-faint" : "bg-success", "On"]
  const line = running
    ? running.direction === "off" ? "Turning off. The steps run in this order."
      : running.renew ? "Renewing. Tailscale is asked for the certificate again, then the daemon restarts once."
        : "Turning on. The steps run in this order."
    : stoppedOn ? (httpsOff ? "Stopped before storing or restarting anything." : "The switch stays off.")
      : !report ? (readError ?? "Reading the tailnet status from Tailscale.")
        : report.state === "none" ? "No tailnet interface found on this machine. Domovoi does not set one up for you."
          : stillAnswering ? "The switch is off, but the daemon still answers on the tailnet."
          // Codex review round 1 (P3-6): only this computer only when known: a
          // hand-set DOMOVOI_HOST beyond loopback listens beyond it, and a
          // tailnet listener tailnet.status did not answer for is not known.
          // Round 2 (P3): tailnet.status speaks for the second listener only.
          // The first is known to be loopback only for the daemon inside this
          // app, whose DOMOVOI_HOST the desktop reads; an attached daemon's is
          // not known from here.
          : report.state === "off" && report.ignored ? "Off. The daemon also listens where DOMOVOI_HOST says, beyond this computer."
          : report.state === "off" && (listener === undefined || !inApp) ? "Off. Whether the daemon answers anywhere but this computer is not known from here."
          : report.state === "off" ? "Off. Only this computer can reach the daemon."
            : notAnswering ? "On, but the daemon is not answering on the tailnet."
              : renewalFailed ? (expiry ? `Still on. The certificate did not renew and expires on ${day(expiry)}.` : "Still on. The certificate did not renew.")
                : unconfirmed ? "On. Whether the daemon answers on the tailnet is not known from here."
                  : "Devices on your tailnet can reach the daemon. Each one still has to pair."
  const mono = report?.state === "none" ? report.detail : report?.state === "off" ? `${report.name} · read from Tailscale, not changed` : named?.name
  // Beside a hand-set DOMOVOI_HOST the daemon would not use the settings, so
  // the switch offers no turning on; turning off stays.
  const locked = !report || report.state === "none" || running !== undefined || (report.state === "off" && report.ignored !== undefined)

  const facts = isOn && named && !running ? [
    { label: "Tailnet name", value: named.name },
    ...(expiry ? [{ label: "Certificate", value: `expires ${day(expiry)}`, note: renewalFailed ? "Renewal failed. Retrying on its own while this app is open." : "Renews on its own while this app is open.", bad: Boolean(renewalFailed) }] : []),
    { label: "Stored in", value: named.stored },
    { label: "Answers on", value: listening ? `127.0.0.1 · ${named.name}` : unconfirmed ? "127.0.0.1 · the tailnet not confirmed" : "127.0.0.1 only" },
  ] : []

  return (
    <section
      ref={ref}
      id="settings-tailnet"
      aria-labelledby="settings-tailnet-title"
      className={`flex flex-col gap-3 transition-colors duration-300 ${inCard ? "border-t pt-3" : "rounded-lg border bg-card p-4"} ${flash ? "bg-primary/10" : ""}`}
    >
      <div className="flex items-start gap-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span id="settings-tailnet-title" className="text-[12.5px] font-medium">{title}</span>
          <span className="text-[11.5px] leading-[1.55] text-muted-foreground">{line}</span>
          {mono ? <span className="truncate font-machine text-[10.5px] text-faint">{mono}</span> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2.5 pt-px">
          <span className="flex items-center gap-[7px] text-[11.5px] text-strong">
            <span aria-hidden className={`size-[7px] rounded-full ${tone}`} />
            {label}
          </span>
          <Switch aria-label={title} checked={running ? running.direction === "on" : isOn} disabled={locked} onCheckedChange={(checked: boolean) => { void (checked ? controller.turnOn() : controller.turnOff()) }} />
        </div>
      </div>
      {running ? <span aria-hidden className="relative block h-[3px] w-[60px] overflow-hidden rounded-[3px] bg-muted"><span className="sweep-bar absolute inset-y-0 left-0 block w-[30%] rounded-[3px] bg-primary" /></span> : null}

      {named?.ignored && !running ? <p className="m-0 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground">{named.ignored}</p> : null}
      {/* Round 3 re-review (P3-3): kept until someone moves them; never removed for them. Codex review round 6 (P3-1): with every state, no tailnet included. */}
      {report?.kept ? <p role="alert" className="m-0 rounded-md border border-danger-border bg-danger-background px-3 py-2 text-[11.5px] text-danger-foreground">{`The previous certificate and key could not be put back and are in ${report.kept}.`}</p> : null}
      {/* Round 4 review (P3-3): found when the app started, from a put-back that failed or a change cut off before it finished. */}
      {report?.setAside ? <p className="m-0 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground">{`Domovoi found an earlier certificate and key it set aside in ${report.setAside}. They may be from a change that did not finish.`}</p> : null}
      {/* Q417 A: a turn-off deleted the record, then could not delete the files it set aside. */}
      {report?.undeleted ? <p className="m-0 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground">{`The certificate and key were set aside in ${report.undeleted} and could not be deleted.`}</p> : null}

      {report?.state === "none" || (!report && readError) ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button type="button" variant="outline" size="sm" onClick={controller.check}>Check again</Button>
          <span className="text-[11px] leading-[1.5] text-muted-foreground">Bring Tailscale up yourself, then check again.</span>
        </div>
      ) : null}

      {stillAnswering && !running ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground">
          {/* Round 3 re-review (P3-2): offered only when turning off clears it. */}
          {named?.handSet ? <span className="min-w-0 flex-1">{named.handSet}</span> : (
            <>
              <span className="min-w-0 flex-1">Turning it off again clears the setting from the daemon and restarts it on 127.0.0.1 only.</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void controller.turnOff()}>Turn it off again</Button>
            </>
          )}
        </div>
      ) : null}

      {report?.state === "off" && !running && !failedRows && !stillAnswering ? (
        <>
          {!report.httpsCertificates && !failure ? (
            <div className="flex flex-col gap-[3px] text-[11px] leading-[1.5] text-warn-foreground">
              <span>{`HTTPS certificates are off for ${tailnet}.`}</span>
              <span>A tailnet admin turns on HTTPS Certificates on the DNS page of the Tailscale admin console.</span>
            </div>
          ) : null}
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
            <div className="flex flex-col gap-2 rounded-[calc(var(--radius)-3px)] border bg-background px-3 py-[11px]">
              <span className="text-[10.5px] font-medium tracking-[0.13em] text-faint">TURNING IT ON CHANGES</span>
              {[
                { label: "Asks Tailscale for a certificate for this machine's own name", mono: `tailscale cert ${report.name}` },
                { label: "Stores the certificate and key in the Domovoi profile", mono: report.stored },
                { label: "Restarts the service once so it answers on the tailnet", mono: restart },
              ].map((change) => (
                <div key={change.label} className="flex flex-col gap-[3px]">
                  <span className="text-[11.5px] leading-[1.5] text-strong">{change.label}</span>
                  <span className="font-machine text-[10.5px] break-all text-muted-foreground">{change.mono}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-2 rounded-[calc(var(--radius)-3px)] border border-dashed px-3 py-[11px]">
              <span className="text-[10.5px] font-medium tracking-[0.13em] text-faint">DOMOVOI NEVER TOUCHES</span>
              {["Tailnet settings, access rules or DNS entries", "Whether Tailscale is up, or who is signed in to it", "Any other machine on the tailnet"].map((text) => (
                <span key={text} className="text-[11.5px] leading-[1.5] text-strong">{text}</span>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-[3px] text-[11px] leading-[1.5] text-muted-foreground">
            <span>Every certificate is recorded in public logs, so this machine's tailnet name becomes public.</span>
            <span>Turning it off deletes those files and restarts the service on 127.0.0.1 only.</span>
          </div>
        </>
      ) : null}

      {running ? <Steps rows={(running.direction === "on" ? onSteps : offSteps).map((row) => ({ label: row.label, mono: row.mono, state: "" }))} busy /> : null}
      {!running && failedRows ? <Steps rows={failedRows} busy={false} /> : null}

      {!running && failure ? (
        httpsOff ? (
          <Alert
            heading={`HTTPS certificates are off for ${tailnet}`}
            body="A tailnet admin turns on HTTPS Certificates on the DNS page of the Tailscale admin console. Domovoi never falls back to plain HTTP or a self-signed certificate."
            mono={`tailscale status --json · no certificate domain for ${name}`}
            action="Try again" onAction={() => void controller.turnOn()}
            after="The switch stays off. Nothing was stored and nothing restarted."
          />
        ) : (
          <Alert
            heading={failure.direction === "on" ? "Could not turn it on" : "Could not turn it off"}
            body={failure.outcome.message} mono={failure.outcome.detail}
            action="Try again" onAction={() => void (failure.direction === "on" ? controller.turnOn() : controller.turnOff())}
          />
        )
      ) : null}

      {!running && renewalFailed ? (
        <Alert
          heading="The certificate did not renew"
          body={expiry ? `Until ${day(expiry)} paired devices keep connecting and new ones can pair. After that the daemon answers on this computer only until a renewal succeeds.` : "Paired devices keep connecting until the certificate expires. After that the daemon answers on this computer only until a renewal succeeds."}
          mono={`${moment(renewalFailed.at)} · ${renewalFailed.message}`}
          action="Renew now" onAction={() => void controller.turnOn()}
          after="Domovoi also tries again on its own while this app is open."
        />
      ) : null}
      {!running && refusedListener ? (
        <Alert
          heading="The daemon is not answering on the tailnet"
          body={refusedListener.reason}
          mono={`tailnet.status · ${refusedListener.address}`}
          action="Renew now" onAction={() => void controller.turnOn()}
          after={refusedListener.retrying ? "The daemon tries the address again on its own." : undefined}
        />
      ) : null}

      {facts.length ? (
        <dl className="m-0 flex flex-col overflow-hidden rounded-[calc(var(--radius)-3px)] border bg-background">
          {facts.map((fact, index) => (
            <div key={fact.label} className={`flex items-start gap-2.5 px-3 py-[9px] ${index ? "border-t" : ""}`}>
              <dt className="w-[104px] shrink-0 text-[11.5px] text-muted-foreground">{fact.label}</dt>
              <dd className="m-0 flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="font-machine text-[10.5px] break-all text-strong">{fact.value}</span>
                {"note" in fact && fact.note ? <span className={`text-[11.5px] leading-[1.5] ${fact.bad ? "text-destructive" : "text-muted-foreground"}`}>{fact.note}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}
