import { localOwnerRequiredErrorCode, type ApprovalRule, type ClientKind, type FleetSnapshotOverflow, type PairedDeviceSummary, type ProviderRuntime, type UpdateStatus } from "@getdomovoi/protocol"
import { ChevronRightIcon, ExternalLinkIcon, TerminalIcon } from "lucide-react"
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AppearanceSettings, ExternalEditorSettings, ProviderSettings, type MachineAgents, type ProviderSecretStatus } from "./provider-settings.js"
import type { WorkspaceTheme } from "./appearance.js"
import { DaemonRpcError } from "./client.js"
import type { DaemonServiceOutcome, DaemonServiceStatusReport, DesktopExternalEditor, WorkspaceWindowDecoration } from "./desktop-platform.js"
import { failedStill, loginServices, readBackFact, windowsCrashPolicy, type FailedServiceOutcome } from "./login-service-copy.js"
import { CommandLinksRow, useCommandLinkView } from "./command-links.js"
import { printedCommand } from "./printed-command.js"
import { NotificationSettings } from "./notification-settings.js"
import type { NotificationPreferences } from "./notification-preferences.js"
import type { WorkspaceClientCapabilities } from "./workspace-platform.js"
import { PermissionRuleSettings } from "./permission-settings.js"
import { PairingCard, type IssuedPairingCode } from "./pairing-card.js"
import { TailnetReachCard, useTailnetReach, type TailnetReachController, type TailnetReachSource } from "./tailnet-reach-card.js"


type DesktopCapability = {
  externalEditor: DesktopExternalEditor
  onExternalEditorChange: (editor: DesktopExternalEditor) => void
  windowDecoration: WorkspaceWindowDecoration
  activeWindowDecoration: WorkspaceWindowDecoration
  onWindowDecorationChange: (decoration: WorkspaceWindowDecoration) => void
}

export type LocalDaemonDescription = {
  title: string
  detail: string
  // Who holds the daemon, when the client can tell: this app, another Domovoi
  // window, or a daemon started outside any app (the login service or a
  // domovoid run by hand). With the platform, Settings draws the daemon
  // section (J24); without them, the older card.
  owner?: "app" | "other-app" | "outside" | undefined
  // Whether the login service is installed is its own fact. A daemon started
  // outside the app is only drawn as the service when a source reports it.
  serviceInstalled?: boolean | undefined
  // Whether the service itself runs, from the same read. Only then is a
  // daemon outside the app drawn as the running service (security review
  // round 9): a daemon answering is not proof the service runs.
  serviceRunning?: boolean | undefined
  serviceReport?: DaemonServiceStatusReport | undefined
  // Captured with the guarded status read, never when Settings mounts.
  serviceCheckedAt?: number | undefined
  // The daemon version the service answered with, and this app's, so an app
  // update that left the service on its old runtime is said (ruled 2026-09-23).
  serviceVersion?: string | undefined
  appVersion?: string | undefined
  platform?: "darwin" | "linux" | "win32" | undefined
  // Present on a desktop that ships a daemon runtime and can install the
  // login service. The refusal names the work in flight; while it is set the
  // switch waits and nothing is interrupted.
  service?: {
    install: () => Promise<DaemonServiceOutcome>
    remove: () => Promise<DaemonServiceOutcome>
    // Moves an older service to this app's runtime in place (ruled
    // 2026-09-23, B). Absent where the desktop cannot update it.
    update?: (() => Promise<DaemonServiceOutcome>) | undefined
    // The service as the desktop reads it now, for an answer this window
    // could not read.
    status?: (() => Promise<DaemonServiceStatusReport>) | undefined
    refusal?: string | undefined
  } | undefined
  // True while this app owns the daemon, so quitting it disconnects every
  // paired device; the pairing card says so.
  inApp?: boolean | undefined
}

type ServicePhase =
  | { kind: "idle" }
  | { kind: "installing" }
  | { kind: "removing" }
  // lingerWarning: the daemon's own text, shown as it is (ruling Q307).
  | { kind: "installed"; target: string; lingerWarning?: string | undefined }
  // lingerNote, lingerWarning: the daemon's own line on what a Linux removal
  // did to lingering (D28), shown as it is.
  | { kind: "removed"; daemonRunning: boolean; attached: boolean; recovery?: string | undefined; lingerNote?: string | undefined; lingerWarning?: string | undefined }
  | { kind: "waits"; refusal: string }
  | { kind: "unchecked"; message: string }
  | { kind: "not-attached"; message: string }
  | { kind: "failed"; action: "install" | "remove"; message: string; still: string; header?: string | undefined }
  | { kind: "updating" }
  | { kind: "updated" }
  | { kind: "update-not-attached"; message: string }
  // Only the daemon's own words (update-outcome, approved 2026-09-23).
  | { kind: "update-failed"; message: string }

const profileRecoverCommand = "domovoid profile recover --confirm-no-supervisor"

// Release versions are major.minor.patch; anything else is not compared.
function parseRelease(version: string) {
  return /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)?.slice(1).map(Number)
}

function olderRelease(version: string, than: string): boolean {
  const left = parseRelease(version)
  const right = parseRelease(than)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]!
  }
  return false
}

type FailedOutcome = FailedServiceOutcome

async function readServiceBack(status: (() => Promise<DaemonServiceStatusReport>) | undefined): Promise<FailedOutcome["service"]> {
  if (!status) return null
  try {
    const report = await status()
    return "unavailable" in report ? null : { installed: report.installed, running: report.running }
  } catch {
    return null
  }
}

// Review round 3 of #576: what is still true after an answer this window could
// not read. Only the read-back speaks; the daemon's state is not known here.
function unknownAnswerStill(kind: string, action: "install" | "remove", service: FailedOutcome["service"]): string {
  // Approved by fetzy on 2026-09-25: a removal whose answer was unreadable and
  // whose read-back shows no service. "Gone, but the removal did not finish"
  // would claim more than is known.
  if (action === "remove" && service?.installed === false) return `The ${kind} is not installed.`
  return readBackFact(kind, action, service)
}

// Ruled 2026-09-25: an unreadable answer whose read-back shows the change
// happened, in whole or in part, is not headed "Could not install" or "Could
// not remove". The headers were approved by fetzy on 2026-09-25.
function unknownAnswerHeader(action: "install" | "remove", service: FailedOutcome["service"]): string | undefined {
  if (!service || service.installed === null) return undefined
  const happened = action === "install" ? service.installed : !(service.installed && service.running)
  if (!happened) return undefined
  return action === "install" ? "Could not confirm the install" : "Could not confirm the removal"
}

// The daemon installer's own words for a removal that leaves the profile owner
// unresolved (service/install.ts), led by what did happen.
function removalRecovery(outcome: Extract<DaemonServiceOutcome, { ok: true }>): string | undefined {
  if (outcome.profileRecovery === "proof-unavailable" && outcome.profileRecoveryDetail) {
    return `Removed. ${outcome.profileRecoveryDetail}. No recovery receipt was written. Repair or inspect that file, then after confirming no custom or legacy supervisor will restart the daemon, run this in a terminal.`
  }
  if (outcome.profileRecovery === "operator-confirmation-required" || outcome.profileRecovery === "proof-unavailable") {
    return "Removed. The profile owner remains unresolved. After confirming no custom or legacy supervisor will restart it, run this in a terminal."
  }
  return undefined
}

// Q349 A: removal stops every session on the next quit, so Remove asks first,
// as the 2026-09-23 desktop design draws it. The order and the rows follow the
// daemon's installer (service/install.ts): it stops the service, and if the
// manager refuses, deletes nothing; then it deletes the service definition and
// the record, and on Linux turns lingering off only where its record says
// Domovoi turned it on. The desktop then starts the daemon inside this app.
function RemoveServiceDialog({ open, platform, onOpenChange, onConfirm }: {
  open: boolean
  platform: keyof typeof loginServices
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const service = loginServices[platform]
  const eyebrow = "m-0 text-[10.5px] font-medium tracking-[0.13em] text-faint"
  const removed = [
    { label: service.removeLabel, value: service.definition },
    { label: "Delete the service record", value: "~/.domovoi/service.json" },
    ...(platform === "linux" ? [{ label: "Turn lingering off, if Domovoi turned it on", value: "loginctl disable-linger" }] : []),
  ]
  const kept = ["Sessions, worktrees and checkpoints", "Pairings, and the tokens in your keychain", "This app and the daemon inside it"]
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-[560px]">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex flex-wrap items-baseline gap-2.5">
            Remove the login service?
            <span className="font-machine text-[10.5px] font-normal text-faint">{service.kind}</span>
          </AlertDialogTitle>
          <AlertDialogDescription>Domovoi unloads the service, deletes exactly these, then starts the daemon inside this app again. If unloading fails, nothing else is touched.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 text-[12px] leading-[1.5]">
          <p id="service-removed" className={eyebrow}>REMOVED</p>
          <ul aria-labelledby="service-removed" className="m-0 list-none overflow-hidden rounded-lg border p-0">
            {removed.map((row, index) => (
              <li key={row.label} className={`flex flex-col gap-0.5 px-3 py-2.5${index ? " border-t" : ""}`}>
                <span>{row.label}</span>
                <span className="font-machine text-[10.5px] text-strong">{row.value}</span>
              </li>
            ))}
          </ul>
          <p id="service-kept" className={eyebrow}>KEPT</p>
          <ul aria-labelledby="service-kept" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {kept.map((line) => (
              <li key={line} className="flex items-center gap-2.5 text-strong">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-faint" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 pt-0.5">After this, quitting Domovoi stops the daemon and every session on it.</p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>Remove the service</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

type SupervisorFacts = {
  crashCount?: number
  restartCount?: number
  windowsTaskKind?: "legacy" | "supervised"
  lastExit?: string
  pid?: number
  startedAt?: string
  supervisionFailure?: "exhausted" | "observation-failure" | "configuration-missing"
  supervising?: boolean
  treeUnconfirmed?: boolean
}

// Like the tailnet card, accept the complete schema or display no facts.
// Preload only checks plain-object transport to stay within its byte budget.
function parseSupervisorFacts(value: unknown): SupervisorFacts | undefined {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return undefined
  const integer = (entry: unknown, min: number, max: number) => typeof entry === "number" && Number.isInteger(entry) && entry >= min && entry <= max
  const schema: Record<keyof SupervisorFacts, (entry: unknown) => boolean> = {
    crashCount: (entry) => integer(entry, 0, 4),
    restartCount: (entry) => integer(entry, 0, 4_294_967_295),
    windowsTaskKind: (entry) => entry === "legacy" || entry === "supervised",
    pid: (entry) => integer(entry, 1, 2_147_483_647),
    lastExit: (entry) => typeof entry === "string" && /^(?:code -?[0-9]{1,16}|signal SIG[A-Z0-9]{1,24}|launch failure [A-Z0-9_-]{1,64})$/u.test(entry),
    startedAt: (entry) => typeof entry === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(entry)
      && Number.isFinite(Date.parse(entry)) && new Date(entry).toISOString() === entry,
    supervisionFailure: (entry) => entry === "exhausted" || entry === "observation-failure" || entry === "configuration-missing",
    supervising: (entry) => typeof entry === "boolean",
    treeUnconfirmed: (entry) => typeof entry === "boolean",
  }
  if (!Object.entries(value).every(([key, entry]) => Object.hasOwn(schema, key) && schema[key as keyof SupervisorFacts](entry))) return undefined
  if (Object.hasOwn(value, "restartCount") && (Object.hasOwn(value, "crashCount") || Object.hasOwn(value, "windowsTaskKind"))) return undefined
  return value as SupervisorFacts
}

function knownSourceCommit(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) ? value : undefined
}

// `footer` is the design's last row of the card: About this build.
function DaemonSection({ daemon, footer, buildStatus, buildSettled, onUpdated }: { buildStatus: UpdateStatus | undefined; buildSettled: boolean; onUpdated: () => void; daemon: LocalDaemonDescription & { owner: NonNullable<LocalDaemonDescription["owner"]>; platform: NonNullable<LocalDaemonDescription["platform"]> }; footer?: ReactNode }) {
  const service = loginServices[daemon.platform]
  // Q336 A: every printed command names what runs on this machine.
  const links = useCommandLinkView()
  const printed = (command: string) => printedCommand(command, links)
  const [phase, setPhase] = useState<ServicePhase>({ kind: "idle" })
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const live = daemon.service
  const busy = phase.kind === "installing" || phase.kind === "removing"
  const [checking, setChecking] = useState(false)
  const checkedAt = daemon.serviceCheckedAt
  const check = async () => {
    if (!live?.status) return
    setChecking(true)
    // The shell records failures under the same generation guard as success.
    try { await live.status().catch(() => {}) } finally { setChecking(false) }
  }
  const report = checking ? undefined : daemon.serviceReport
  const observed = report && "installed" in report ? report : undefined
  // appSourceCommit is transport metadata, not a supervisor fact. Strip it
  // before the strict supervisor parser so it cannot imply a service exists.
  const transport = observed?.supervisor
  const { appSourceCommit, ...supervisorReport } = transport && Object.getPrototypeOf(transport) === Object.prototype
    ? transport as Record<string, unknown> : {}
  const appCommit = knownSourceCommit(appSourceCommit)
  const serviceCommit = buildStatus?.currentVersion === daemon.serviceVersion ? knownSourceCommit(buildStatus?.currentSourceCommit) : undefined
  const supervisor = parseSupervisorFacts(supervisorReport)
  const hasService = observed?.installed === true || (observed?.installed === null && supervisor !== undefined && Object.keys(supervisor).length > 0)
  const crashes = supervisor?.crashCount === undefined ? "Crash count unknown" : `${supervisor.crashCount} ${supervisor.crashCount === 1 ? "crash" : "crashes"}`
  const exhausted = hasService && supervisor?.supervisionFailure === "exhausted"
  const birth = observed?.running && supervisor?.startedAt ? Date.parse(supervisor.startedAt) : NaN
  const minutes = Number.isFinite(birth) && checkedAt !== undefined && Number.isFinite(checkedAt) && birth <= checkedAt ? Math.floor((checkedAt - birth) / 60_000) : undefined
  const uptime = minutes === undefined ? "Uptime unknown" : minutes < 60 ? `up ${minutes}m` : `up ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  const run = async (action: "install" | "remove") => {
    if (!live) return
    setPhase({ kind: action === "install" ? "installing" : "removing" })
    try {
      const outcome = await (action === "install" ? live.install() : live.remove())
      if (outcome.ok) setPhase(action === "install" ? { kind: "installed", target: outcome.target, lingerWarning: outcome.lingerWarning } : { kind: "removed", daemonRunning: outcome.daemonRunning, attached: outcome.daemonAttached === true, recovery: removalRecovery(outcome), lingerNote: outcome.lingerNote, lingerWarning: outcome.lingerWarning })
      else if (outcome.reason === "refused") setPhase({ kind: "waits", refusal: outcome.message })
      else if (outcome.reason === "check-failed") setPhase({ kind: "unchecked", message: outcome.message })
      else if (outcome.reason === "installed-not-attached") setPhase({ kind: "not-attached", message: outcome.message })
      else if (outcome.reason === "update-failed") setPhase({ kind: "failed", action, message: outcome.message, still: "Nothing changed." })
      else setPhase({ kind: "failed", action, message: outcome.message, still: outcome.reason === "runtime-missing"
        ? "No service was installed and no service files were changed."
        : outcome.reason === "busy" ? "Nothing changed." : failedStill(service.kind, action, outcome) })
    } catch (cause) {
      // The desktop may have finished the change before its answer failed
      // here, so what changed is read back rather than assumed.
      const readBack = await readServiceBack(live.status)
      setPhase({ kind: "failed", action, message: cause instanceof Error ? cause.message : "The desktop did not answer.", still: unknownAnswerStill(service.kind, action, readBack), header: unknownAnswerHeader(action, readBack) })
    }
  }
  const update = async () => {
    if (!live?.update) return
    setPhase({ kind: "updating" })
    try {
      const outcome = await live.update()
      if (outcome.ok) { setPhase({ kind: "updated" }); onUpdated() }
      else if (outcome.reason === "refused") setPhase({ kind: "waits", refusal: outcome.message })
      else if (outcome.reason === "check-failed") setPhase({ kind: "unchecked", message: outcome.message })
      else if (outcome.reason === "installed-not-attached") setPhase({ kind: "update-not-attached", message: outcome.message })
      else setPhase({ kind: "update-failed", message: outcome.message })
    } catch (cause) {
      setPhase({ kind: "update-failed", message: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  // Security review round 8: whether the service is installed is its own
  // fact, from the desktop's read of it, and decides Install, Remove and what
  // was written. Who holds the daemon decides the toggle and its quit line. A
  // failed install can leave the service installed while the daemon is back
  // inside this app; Remove is live then.
  const installed = daemon.serviceInstalled === true
  const on = daemon.owner === "outside" && installed && daemon.serviceRunning === true
  const unknown = daemon.owner === "outside" && !on
  const serviceBehind = on && phase.kind !== "updated" && daemon.serviceVersion !== undefined && daemon.appVersion !== undefined && olderRelease(daemon.serviceVersion, daemon.appVersion)
  const sameVersion = on && daemon.serviceVersion !== undefined && daemon.serviceVersion === daemon.appVersion && parseRelease(daemon.serviceVersion) !== undefined
  const comparisonSettled = buildSettled && report !== undefined
  const replaceBuild = comparisonSettled && sameVersion && phase.kind !== "updated" && appCommit !== undefined && serviceCommit !== undefined && appCommit !== serviceCommit
  const unknownBuild = comparisonSettled && sameVersion && (appCommit === undefined || serviceCommit === undefined)
  const updating = phase.kind === "updating"
  const state = on
    ? { label: "Running", tone: "bg-success", line: "Quitting this app leaves the daemon and its sessions running." }
    : unknown
      ? { label: "Not started here", tone: "bg-faint", line: "A daemon this app did not start. Quitting this app leaves it running." }
      : daemon.owner === "app"
        ? { label: "Off", tone: "bg-faint", line: "Quitting Domovoi stops the daemon and every session on it." }
        : { label: "Off", tone: "bg-faint", line: daemon.detail }
  const facts = [
    { label: "Service", value: service.definition, note: `A ${service.kind}, for your user only.`, item: installed ? "written" : "will write" },
    { label: "Record", value: "~/.domovoi/service.json", note: "What Domovoi installed, so removing undoes exactly that.", item: installed ? "written" : "will write" },
    ...(on ? [{ label: "After a crash", value: "", note: daemon.platform === "win32" ? windowsCrashPolicy(supervisor?.windowsTaskKind) : service.crash, item: "" }] : []),
  ]
  const command = printed(unknown ? "domovoid service status" : installed ? "domovoid service remove" : "domovoid service install")
  const lockReason = busy
    ? (phase.kind === "installing" ? "Both wait until the install finishes." : "Both wait until the removal finishes.")
    : installed
      ? "Install is off: the service is already installed."
      : unknown ? "Install and Remove are off: this app did not start that daemon." : "Remove is off: nothing is installed."
  const installLocked = !live || installed || unknown || busy || updating || checking || Boolean(live.refusal)
  const removeLocked = !live || !installed || busy || updating || checking || Boolean(live.refusal)
  // Review P3-8: a confirmation that Remove locking closed stays closed when
  // the lock lifts; the person asks again.
  useEffect(() => {
    if (removeLocked) setConfirmingRemove(false)
  }, [removeLocked])
  return (
    <section aria-labelledby="settings-daemon" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 id="settings-daemon" className="m-0 text-[13px] font-medium">Daemon on this machine</h2>
        <p className="m-0 text-[11.5px] text-muted-foreground">It owns every session here. This window and a paired phone are both its clients.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[12.5px]">Keep Domovoi running after I quit</span>
          <span className="text-[11px] text-muted-foreground">{state.line}</span>
        </div>
        <span className="flex items-center gap-2 text-[11.5px] font-medium text-strong">
          <span aria-hidden className={`size-[7px] rounded-full ${busy ? "bg-primary" : state.tone}`} />
          {phase.kind === "installing" ? "Installing" : phase.kind === "removing" ? "Removing" : state.label}
        </span>
      </div>
      {report || live?.status ? <>
        {exhausted ? <div role="alert" className="flex flex-col gap-1.5 rounded-md border border-danger-border bg-danger-background px-3 py-2 text-[11.5px] text-danger-foreground">
          <span className="font-medium">{supervisor.crashCount === undefined ? "The supervisor gave up. Crash count unknown." : `The supervisor gave up after ${crashes}.`}</span>
          <span>The supervisor stopped trying: restart limit reached.</span>
          <span>{daemon.owner === "outside" ? "Stop the daemon running outside this app before running the command." : `Quit ${daemon.owner === "app" ? "this" : "the other"} Domovoi app to stop its daemon and sessions before running the command.`}</span>
          <span>To reinstall and start the service, run this in a terminal.</span>
          <span className="font-machine text-[11px]">{printed("domovoid service install")}</span>
        </div> : null}
        {report && "unavailable" in report ? <p className="m-0 text-[11.5px] text-muted-foreground">{report.unavailable}</p> : null}
        {supervisor?.supervisionFailure && !exhausted ? <p className="m-0 text-[11.5px] text-muted-foreground">{observed?.detail}</p> : null}
        <div aria-live="polite" aria-busy={checking} className="flex flex-wrap items-center gap-x-3 gap-y-1 font-machine text-[11px] text-muted-foreground">
          {checking ? <span>Checking status</span> : hasService ? <>
            {observed?.running ? <>
              <span>{supervisor?.pid !== undefined ? `PID ${supervisor.pid}` : "PID unknown"}</span>
              <span>{uptime}{minutes === undefined ? "" : " at last check"}</span>
            </> : null}
            <span>{supervisor?.restartCount !== undefined
              ? `${supervisor.restartCount} automatic ${supervisor.restartCount === 1 ? "restart" : "restarts"} since the last start by sign-in, install or hand, or the last counter reset`
              : daemon.platform === "linux" && supervisor?.crashCount === undefined ? "Automatic restart count unknown" : crashes}</span>
            <span>{supervisor?.lastExit ? `Last exit: ${supervisor.lastExit}` : "Last exit unknown"}</span>
            {supervisor?.supervisionFailure === undefined && supervisor?.crashCount === undefined ? <span>Supervisor exhaustion unknown</span> : null}
          </> : null}
        </div>
        {live?.status ? <div><Button type="button" variant="outline" size="sm" disabled={checking || busy || updating} onClick={() => void check()}>Check again</Button></div> : null}
      </> : null}
      {serviceBehind || replaceBuild ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground">
          <p className="m-0 min-w-0 flex-1">{replaceBuild ? "The service and this app have the same version but different build commits." : `The login service runs Domovoi ${daemon.serviceVersion}. This app is ${daemon.appVersion}.`}</p>
          {live?.update ? <Button type="button" variant="outline" size="sm" disabled={busy || updating || checking || Boolean(live.refusal)} onClick={() => void update()}>{replaceBuild ? "Replace the service with this app's build" : "Update the service"}</Button> : null}
        </div>
      ) : null}
      {unknownBuild ? <p className="m-0 text-[11.5px] text-muted-foreground">Build comparison is unavailable because this app's or the service's commit is unknown.</p> : null}
      {phase.kind === "update-failed" ? (
        <p className="m-0 rounded-md border border-danger-border bg-danger-background px-3 py-2 text-[11.5px] text-danger-foreground" role="alert">{phase.message}</p>
      ) : null}
      {phase.kind === "update-not-attached" ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground" role="alert">
          <span className="font-medium">Updated, but this window could not reach the daemon</span>
          <span className="font-machine text-[10.5px] opacity-80">{phase.message}</span>
        </div>
      ) : null}
      {phase.kind === "installing" ? <p className="m-0 text-[11.5px] text-muted-foreground">{`The daemon moves under ${service.manager}. The switch waits.`}</p> : null}
      {phase.kind === "removing" ? <p className="m-0 text-[11.5px] text-muted-foreground">Unloading the service, then starting the daemon inside this app again. The switch waits.</p> : null}
      {live?.refusal && !busy ? <p className="m-0 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground">{`The switch waits: ${live.refusal} Nothing is interrupted.`}</p> : null}
      {phase.kind === "installed" ? (
        <div className="flex flex-col gap-1 rounded-md border border-ok-border bg-ok-background px-3 py-2 text-[11.5px] text-ok-foreground" role="status">
          <span>Installed. Quitting this app now leaves the daemon and its sessions running.</span>
          <span className="font-machine text-[10.5px] opacity-80">{phase.target}</span>
        </div>
      ) : null}
      {phase.kind === "installed" && phase.lingerWarning ? <p className="m-0 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground" role="status">{phase.lingerWarning}</p> : null}
      {phase.kind === "removed" ? (
        <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2 text-[11.5px]" role="status">
          {phase.recovery ? (
            <>
              <span>{phase.recovery}</span>
              <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />{printed(profileRecoverCommand)}</span>
            </>
          ) : phase.daemonRunning && !phase.attached ? <span>Removed. Quitting Domovoi now stops the daemon and every session on it.</span> : null}
          {phase.daemonRunning && phase.attached ? <span>{`${phase.recovery ? "" : "Removed. "}This app is connected to a daemon it did not start. Quitting this app leaves it running.`}</span> : null}
          {phase.daemonRunning ? null : <span>{`${phase.recovery ? "" : "Removed. "}The daemon did not start again inside this app, so no session is running. Quit and reopen Domovoi to start it.`}</span>}
          {phase.lingerNote ? <span>{phase.lingerNote}</span> : null}
        </div>
      ) : null}
      {phase.kind === "removed" && phase.lingerWarning ? <p className="m-0 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground" role="status">{phase.lingerWarning}</p> : null}
      {phase.kind === "waits" ? <p className="m-0 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground" role="status">{`The switch waits: ${phase.refusal} Nothing is interrupted.`}</p> : null}
      {phase.kind === "unchecked" ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground" role="status">
          <span>Could not check for running turns or waiting gates, so the switch waits. Nothing is interrupted.</span>
          <span className="font-machine text-[10.5px] opacity-80">{phase.message}</span>
        </div>
      ) : null}
      {phase.kind === "not-attached" ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground" role="alert">
          <span className="font-medium">Installed, but this window could not reach the daemon</span>
          <span className="font-machine text-[10.5px] opacity-80">{phase.message}</span>
          <span>{`The ${service.kind} is installed and the daemon inside this app is stopped. Whether the service started is not known from here.`}</span>
          <span>To check, run this in a terminal.</span>
          <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />{printed("domovoid service status")}</span>
        </div>
      ) : null}
      {phase.kind === "failed" ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-danger-border bg-danger-background px-3 py-2 text-[11.5px] text-danger-foreground" role="alert">
          <span className="font-medium">{phase.header ?? (phase.action === "install" ? "Could not install the service" : "Could not remove the service")}</span>
          <span className="font-machine text-[10.5px] opacity-80">{phase.message}</span>
          <span>{phase.still}</span>
          <span>To finish by hand, run this in a terminal.</span>
          <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />{printed(phase.action === "install" ? "domovoid service install" : "domovoid service remove")}</span>
        </div>
      ) : null}
      {unknown && !installed ? null : <div className="flex flex-col gap-1.5">
        <span className="text-[10.5px] tracking-[0.13em] text-faint">{installed ? "WHAT IT WROTE" : "WHAT TURNING IT ON WRITES"}</span>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[11.5px]">
          {facts.map((fact) => (
            <li key={fact.label} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="w-[84px] shrink-0 text-muted-foreground">{fact.label}</span>
                {fact.value ? <span className="font-machine text-[11px] text-strong">{fact.value}</span> : null}
                {fact.item ? <span className="font-machine text-[10.5px] text-faint">{fact.item}</span> : null}
              </span>
              <span className="pl-[92px] text-[11px] text-muted-foreground">{fact.note}</span>
            </li>
          ))}
        </ul>
      </div>}
      {!live || unknown ? <div className="flex flex-col gap-1.5 rounded-md border border-info-border bg-info-background px-3 py-2 text-[11.5px] text-info-foreground">
        {unknown ? <span>{daemon.serviceInstalled === false
          // Approved by fetzy on 2026-09-25 for a service known not installed.
          ? "The login service is not installed. This daemon was started outside any app and runs until it is stopped. To check by hand, run this in a terminal."
          : installed
            // Approved by fetzy on 2026-09-25 (security review round 9): the
            // service reads back installed but not running, so the daemon
            // outside the app is not the service.
            ? "The login service is installed but not running. This daemon was started outside any app and runs until it is stopped. To check by hand, run this in a terminal."
            : "This app cannot tell whether that daemon is the installed service. To check by hand, run this in a terminal."}</span> : <>
          <span>{installed ? "Removing the service from this window is not built yet." : "Installing the service from this window is not built yet."}</span>
          <span>To finish by hand, run this in a terminal.</span>
        </>}
        <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />{command}</span>
      </div> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={installLocked} {...(live ? {} : { title: "Not built yet" })} onClick={() => void run("install")}>Install</Button>
        <Button size="sm" variant="outline" className="border-danger-border text-destructive" disabled={removeLocked} {...(live ? {} : { title: "Not built yet" })} onClick={() => setConfirmingRemove(true)}>Remove</Button>
        {live?.refusal && !installed && !unknown && !busy ? null : <span className="text-[11px] text-faint">{lockReason}</span>}
      </div>
      <RemoveServiceDialog
        open={confirmingRemove && !removeLocked}
        platform={daemon.platform}
        onOpenChange={setConfirmingRemove}
        onConfirm={() => {
          setConfirmingRemove(false)
          void run("remove")
        }}
      />
      <CommandLinksRow />
      {footer}
    </section>
  )
}

// Phone and tablet, from the 2026-09-23 desktop design: the pairing card,
// then one row sending device management to Machines, where each daemon
// keeps its own list.
export type PairingSettings = {
  connected: boolean
  onIssueCode: (client: ClientKind) => Promise<IssuedPairingCode>
  onCopy: (text: string) => Promise<void>
  onListDevices: () => Promise<{ devices: PairedDeviceSummary[] }>
  inAppDaemon?: boolean | undefined
  // TailnetReach (Q404 A): the desktop's tailnet switch, drawn in the daemon
  // card and reached from the pairing card.
  tailnet?: TailnetReachSource | undefined
}

function PairingSection({ pairing, readOnly, onOpenFleet, tailnet }: { pairing: PairingSettings; readOnly: boolean; onOpenFleet: () => void; tailnet?: TailnetReachController | undefined }) {
  const [count, setCount] = useState<number | null>(null)
  const { onListDevices } = pairing
  useEffect(() => {
    let active = true
    onListDevices().then(
      (result) => { if (active) setCount(result.devices.filter((device) => device.binding.kind === "client" && !device.revokedAt).length) },
      () => { if (active) setCount(null) },
    )
    return () => { active = false }
  }, [onListDevices])
  return (
    <section aria-labelledby="settings-pairing" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="settings-pairing" className="m-0 text-[13px] font-medium">Phone and tablet</h2>
        <p className="m-0 text-[11.5px] text-muted-foreground">Pair a device to watch sessions and answer gates while away from the desk.</p>
      </div>
      <PairingCard connected={pairing.connected} readOnly={readOnly} inAppDaemon={pairing.inAppDaemon ?? false} onIssueCode={pairing.onIssueCode} onCopy={pairing.onCopy} {...(tailnet ? { tailnet } : {})} />
      <Button variant="ghost" className="h-auto justify-between rounded-lg border px-[15px] py-3 text-left" onClick={onOpenFleet}>
        <span className="flex flex-col items-start gap-0.5">
          <span>{count === null ? "Paired devices" : `${count} ${count === 1 ? "client" : "clients"} paired with this daemon`}</span>
          <span className="text-[11px] font-normal text-muted-foreground">Rename, rotate and unpair them on Machines, next to the daemon that issued them.</span>
        </span>
        <ChevronRightIcon className="size-4 text-faint" />
      </Button>
    </section>
  )
}

// About this build (J10, 2026-09-23). The first release is unsigned and does
// not update itself, and Settings says so in one line. scripts/unsigned-build.mjs
// fails the release invariants the day a signing build runs on an automatic
// trigger while this line is still here, so the copy moves with the fact.
export const releasePageUrl = "https://github.com/getdomovoi/domovoi/releases"

export type AboutBuild = {
  version: string
  // Absent where this client may not ask; About then says why it has none.
  onUpdateStatus?: (() => Promise<UpdateStatus>) | undefined
  // The desktop opens the release page in the person's browser; a browser
  // tab links it directly.
  onOpenReleasePage?: (() => Promise<boolean>) | undefined
}

// A daemon that reports a pending target is updating itself, so the body
// drops "does not update itself" and one line names the target. Quarantined
// targets were refused by the daemon and add nothing (ruled 2026-09-23).
function pendingUpdateLine(status: UpdateStatus): string | undefined {
  if (!status.pendingVersion || !status.pendingSourceCommit) return undefined
  const target = `domovoid ${status.pendingVersion} · ${status.pendingSourceCommit.slice(0, 7)}`
  if (status.state === "pending") return `The daemon reports ${target} waiting to switch in.`
  if (status.state === "activating") return `The daemon reports it is switching to ${target} now.`
  if (status.state === "deferred" && status.refusal) return `The daemon reports ${target} waiting. The switch was put off: ${status.refusal.message}`
  return undefined
}

// Share one guarded read between build comparison and the About row.
function useBuildStatus(about: AboutBuild | undefined, revision: number) {
  const [status, setStatus] = useState<UpdateStatus | undefined>(undefined)
  const [settled, setSettled] = useState(false)
  // Q169: the daemon answers update status only to its owner on a direct
  // loopback connection. A paired tab gets a policy refusal, keeps its
  // connection, and says why it has no status instead of going quiet.
  const [ownerOnly, setOwnerOnly] = useState(false)
  const onUpdateStatus = about?.onUpdateStatus
  useEffect(() => {
    // Without a reader this client does not ask (a phone or tablet: the
    // daemon refuses update.status to that credential and drops the
    // connection), and it is not the owner on loopback either, so the same
    // line says why.
    if (!onUpdateStatus) {
      setStatus(undefined)
      setOwnerOnly(true)
      setSettled(true)
      return
    }
    setStatus(undefined)
    setSettled(false)
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    // The desktop reconnects asynchronously after update succeeds. Retry
    // failed post-update reads for up to ten seconds; ordinary status reads
    // and owner-only refusals never poll. Closing Settings cancels the retry.
    const retryUntil = Date.now() + (revision > 0 ? 10_000 : 0)
    const read = () => {
      onUpdateStatus().then(
        (next) => { if (active) { setStatus(next); setOwnerOnly(false); setSettled(true) } },
        (cause: unknown) => {
          if (!active) return
          setStatus(undefined)
          const denied = cause instanceof DaemonRpcError && cause.code === localOwnerRequiredErrorCode
          setOwnerOnly(denied)
          if (!denied && Date.now() < retryUntil) retry = setTimeout(read, 250)
          else setSettled(true)
        },
      )
    }
    read()
    return () => { active = false; clearTimeout(retry) }
  }, [onUpdateStatus, revision])
  return { status, ownerOnly, settled }
}

// On its own, About is a card; inside the daemon card it is the last row.
function AboutBuildSection({ about, inCard = false, build }: { about: AboutBuild; inCard?: boolean; build: ReturnType<typeof useBuildStatus> }) {
  const { status, ownerOnly } = build
  const commit = status?.currentSourceCommit?.slice(0, 7)
  const pending = status ? pendingUpdateLine(status) : undefined
  const openReleasePage = about.onOpenReleasePage
  // Owner ruling 2026-09-25: when the desktop could not open the browser, the
  // row says so and gives the address as selectable mono text to copy.
  // Only the latest click may set or clear the line, so an earlier open that
  // settles late cannot contradict a later one.
  const [browserFailed, setBrowserFailed] = useState(false)
  const latestOpen = useRef(0)
  const openInBrowser = (open: () => Promise<boolean>) => {
    const request = ++latestOpen.current
    setBrowserFailed(false)
    const settle = (failed: boolean) => { if (latestOpen.current === request) setBrowserFailed(failed) }
    open().then((opened) => settle(!opened), () => settle(true))
  }
  // The design's row: facts on the left, the release page as a link on the
  // right. A link, not a button, so a watching window (its controls disabled
  // by the read-only fieldset) can still open it. The desktop hands the fixed
  // address to the browser through the bridge instead of navigating.
  return (
    <section aria-labelledby="settings-about" className={inCard ? "flex items-start gap-3 border-t pt-3" : "flex items-start gap-3 rounded-lg border bg-card p-4"}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 id="settings-about" className="m-0 text-[13px] font-medium">About this build</h2>
          <span className="font-machine text-[10.5px] text-faint">{commit ? `domovoid ${about.version} · ${commit}` : `domovoid ${about.version}`}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span aria-hidden className="size-[7px] rounded-full bg-faint" />
            Not signed
          </span>
        </div>
        {pending ? (
          <>
            <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">This build is not signed. Get new versions from the release page.</p>
            <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">{pending}</p>
          </>
        ) : (
          <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">This build is not signed and does not update itself. Get new versions from the release page.</p>
        )}
        {ownerOnly ? (
          <p className="m-0 text-[11.5px] leading-[1.5] text-muted-foreground">No update status: the daemon answers it only over loopback, to its owner's credential.</p>
        ) : null}
        {openReleasePage ? (
          // Mounted empty before any click so a screen reader announces the
          // line when it appears; the negative margin cancels the column gap
          // while it is empty.
          <p role="status" className="m-0 text-[11.5px] leading-[1.5] text-warning empty:-mt-1.5">
            {browserFailed ? (
              <>Could not open the browser. The release page is <span className="font-machine select-text break-all">{releasePageUrl}</span></>
            ) : null}
          </p>
        ) : null}
      </div>
      <a
        href={releasePageUrl}
        target="_blank"
        rel="noopener"
        className="flex shrink-0 items-center gap-1.5 pt-px text-[11.5px] text-primary underline-offset-2 hover:underline"
        {...(openReleasePage ? { onClick: (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); openInBrowser(openReleasePage) } } : {})}
      >
        Release page
        <ExternalLinkIcon className="size-3.5" />
      </a>
    </section>
  )
}

export type SettingsShellProps = {
  providers: readonly ProviderRuntime[]
  // Every machine's agents as this client knows them; without it the pane
  // lists `providers` for this machine alone.
  providerMachines?: readonly MachineAgents[] | undefined
  // Set when the home daemon withheld the fleet list.
  providerFleetOverflow?: FleetSnapshotOverflow | undefined
  about?: AboutBuild | undefined
  pairing?: PairingSettings | undefined
  secrets: readonly ProviderSecretStatus[]
  // Set in a phone or tablet tab, to the machine's name: provider.secret.list
  // is not on phoneAndTabletRpcMethods, so the tab does not ask for key status
  // and the card says why in place of the key rows (Q84).
  secretsWithheldFrom?: string | undefined
  localDaemon?: LocalDaemonDescription
  approvalRules: readonly ApprovalRule[]
  notifications: NotificationPreferences
  onNotificationsChange: (preferences: NotificationPreferences) => void
  clientCapabilities?: WorkspaceClientCapabilities
  onOpenFleet: () => void
  onOpenSkills: () => void
  onOpenAudit: () => void
  // The sheet's Rules and Checkpoints tabs, as the Desktop V2 frame links
  // them from Elsewhere. Without a handler the link is not drawn.
  onOpenPermissions?: (() => void) | undefined
  onOpenCheckpoints?: (() => void) | undefined
  onResetFirstRun?: () => void
  theme: WorkspaceTheme
  readOnly?: boolean
  onThemeChange: (theme: WorkspaceTheme) => void
} & (DesktopCapability | {
  externalEditor?: undefined
  onExternalEditorChange?: undefined
  windowDecoration?: undefined
  activeWindowDecoration?: undefined
  onWindowDecorationChange?: undefined
})

export function SettingsShell({
  providers,
  providerMachines,
  providerFleetOverflow,
  secrets,
  secretsWithheldFrom,
  about,
  pairing,
  localDaemon,
  approvalRules,
  notifications,
  clientCapabilities,
  externalEditor,
  windowDecoration,
  activeWindowDecoration,
  theme,
  readOnly = false,
  onNotificationsChange,
  onOpenFleet,
  onOpenSkills,
  onOpenAudit,
  onOpenPermissions,
  onOpenCheckpoints,
  onResetFirstRun,
  onExternalEditorChange,
  onWindowDecorationChange,
  onThemeChange,
}: SettingsShellProps) {
  const [buildRevision, setBuildRevision] = useState(0)
  const build = useBuildStatus(about, buildRevision)
  const editorCapability = externalEditor !== undefined && onExternalEditorChange !== undefined
    ? { editor: externalEditor, onChange: onExternalEditorChange }
    : undefined
  // Only for this machine's daemon: Settings for an attached machine gets no
  // localDaemon, and its commands print as written.
  const links = useCommandLinkView()
  const daemonSection = localDaemon?.owner && localDaemon.platform
    ? { ...localDaemon, owner: localDaemon.owner, platform: localDaemon.platform }
    : undefined
  const decorationCapability = windowDecoration !== undefined
    && activeWindowDecoration !== undefined
    && onWindowDecorationChange !== undefined
    ? { decoration: windowDecoration, active: activeWindowDecoration, onChange: onWindowDecorationChange }
    : undefined
  const tailnet = useTailnetReach(pairing?.tailnet)
  // The Desktop V2 frame's Elsewhere, in its order. Checkpoints says what a
  // revert does here: the worktree only, the thread keeps its turns (Q341 A).
  const elsewhereLinks = [
    { label: "Machines and daemons", note: "Transports, agents installed, and what each one is running.", open: onOpenFleet },
    ...(onOpenPermissions ? [{ label: "Permissions and rules", note: "What you have already allowed, and what a rule can never cover.", open: onOpenPermissions }] : []),
    { label: "Skills", note: "Install sources, signing, and which skills a machine may run.", open: onOpenSkills },
    ...(onOpenCheckpoints ? [{ label: "Checkpoints", note: "Take one yourself, or reset a session's worktree to one. The thread keeps its turns.", open: onOpenCheckpoints }] : []),
    { label: "Audit log", note: "Who decided what, on which verified device, and what happened next.", open: onOpenAudit },
  ]

  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <main className="mx-auto flex w-full max-w-[760px] flex-col gap-[26px] px-4 py-5 sm:px-6 sm:py-[30px]">
        <header className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[19px] font-semibold tracking-[-0.01em]">Settings</h1>
          <p className="m-0 text-[12.5px] text-muted-foreground">
            This machine holds its own settings. Nothing here is synced anywhere unless the row says so.
          </p>
        </header>

        <fieldset disabled={readOnly} className="contents">
          {daemonSection ? <DaemonSection daemon={daemonSection} buildStatus={build.status} buildSettled={build.settled} onUpdated={() => setBuildRevision((value) => value + 1)} footer={about || tailnet ? <>{tailnet ? <TailnetReachCard controller={tailnet} inCard /> : null}{about ? <AboutBuildSection about={about} build={build} inCard /> : null}</> : undefined} /> : null}
          {tailnet && !daemonSection ? <TailnetReachCard controller={tailnet} /> : null}

          <section aria-label="Providers and tokens">
            <ProviderSettings providers={providers} machines={providerMachines} fleetOverflow={providerFleetOverflow} secrets={secrets} secretsRefusal={secretsWithheldFrom === undefined ? undefined : `Key status is off in a phone or tablet tab: the daemon does not report it to a phone or tablet credential. Use the desktop app on ${secretsWithheldFrom}.`} {...(localDaemon && !daemonSection ? { localDaemon } : {})} {...(localDaemon ? { printCommand: (command: string) => printedCommand(command, links) } : {})} />
          </section>

          {about && !daemonSection ? <AboutBuildSection about={about} build={build} /> : null}

          {pairing ? <PairingSection pairing={pairing} readOnly={readOnly} onOpenFleet={onOpenFleet} tailnet={tailnet} /> : null}
        </fieldset>

        {/* Q362 A: notifications stay on this client and never reach the
            daemon, so a watching window keeps them live. */}
        <section aria-label="Notifications">
          <NotificationSettings
            preferences={notifications}
            onChange={onNotificationsChange}
            {...(clientCapabilities ? { client: clientCapabilities } : {})}
          />
        </section>

        <fieldset disabled={readOnly} className="contents">
          <section id="permissions-settings" aria-label="Permissions and rules">
            <PermissionRuleSettings rules={approvalRules} />
          </section>

          {editorCapability ? (
            <section aria-label="External editor">
              <ExternalEditorSettings editor={editorCapability.editor} onEditorChange={editorCapability.onChange} />
            </section>
          ) : null}
        </fieldset>

        <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby="settings-elsewhere">
          <div className="border-b px-[15px] py-[13px]">
            <h2 id="settings-elsewhere" className="m-0 text-[13px] font-medium">Elsewhere</h2>
            <p className="mt-1 text-[11.5px] text-muted-foreground">These live on their own screens.</p>
          </div>
          <div className="flex flex-col">
            {elsewhereLinks.map((link, index) => (
              <Button key={link.label} variant="ghost" className={`h-auto justify-start gap-3 rounded-none px-[15px] py-3 text-left${index ? " border-t" : ""}`} onClick={link.open}>
                <span className="flex min-w-0 flex-1 flex-col items-start">
                  <span>{link.label}</span>
                  <span className="text-[11px] font-normal whitespace-normal text-muted-foreground">{link.note}</span>
                </span>
                <ChevronRightIcon aria-hidden className="size-3.5 text-faint" />
              </Button>
            ))}
            {onResetFirstRun ? (
              <Button variant="ghost" className="h-auto justify-start rounded-none border-t px-[15px] py-3 text-left" onClick={onResetFirstRun}>
                First-run setup
              </Button>
            ) : null}
          </div>
        </section>

        {/* Q362 A: theme and window decoration stay on this client, so a
            watching window keeps them live. */}
        <section aria-label="Appearance">
          <AppearanceSettings
            theme={theme}
            onThemeChange={onThemeChange}
            {...(decorationCapability ? {
              windowDecoration: decorationCapability.decoration,
              activeWindowDecoration: decorationCapability.active,
              onWindowDecorationChange: decorationCapability.onChange,
            } : {})}
          />
        </section>
      </main>
    </ScrollArea>
  )
}
