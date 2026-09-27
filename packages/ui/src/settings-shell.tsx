import { loginServiceHomePaths, loginServiceTaskName, type ApprovalRule, type ClientKind, type PairedDeviceSummary, type ProviderRuntime, type UpdateStatus } from "@getdomovoi/protocol"
import { ChevronRightIcon, ExternalLinkIcon, TerminalIcon } from "lucide-react"
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AppearanceSettings, ExternalEditorSettings, ProviderSettings, type ProviderSecretStatus } from "./provider-settings.js"
import type { WorkspaceTheme } from "./appearance.js"
import type { DaemonServiceOutcome, DaemonServiceStatusReport, DesktopExternalEditor, WorkspaceWindowDecoration } from "./desktop-platform.js"
import { NotificationSettings } from "./notification-settings.js"
import type { NotificationPreferences } from "./notification-preferences.js"
import type { WorkspaceClientCapabilities } from "./workspace-platform.js"
import { PermissionRuleSettings } from "./permission-settings.js"
import { PairingCard, type IssuedPairingCode } from "./pairing-card.js"


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

// J24 (2026-09-23). What each platform's login service is. The names come from
// the daemon's installer through login-service; this window only names them.
// Native Windows runs the logon task without the crash supervisor, which only
// the WSL task has (Phase 1 decided to supervise it like WSL). Installing and
// removing from this window are not built: the app ships no daemon runtime a
// service could point at (ND9), so both controls stay locked with the
// command that does the job beside them.
const loginServices = {
  darwin: { kind: "LaunchAgent", manager: "launchd", definition: `~/${loginServiceHomePaths.darwin}`, removeLabel: "Unload and delete the LaunchAgent", crash: "launchd starts it again." },
  linux: { kind: "systemd user unit", manager: "systemd", definition: `~/${loginServiceHomePaths.linux}`, removeLabel: "Stop, disable and delete the user unit", crash: "systemd starts it again." },
  win32: { kind: "logon task", manager: "Task Scheduler", definition: `Task Scheduler task "${loginServiceTaskName}"`, removeLabel: "Delete the logon task", crash: "Nothing restarts it until you next sign in." },
} as const

type ServicePhase =
  | { kind: "idle" }
  | { kind: "installing" }
  | { kind: "removing" }
  | { kind: "installed"; target: string }
  | { kind: "removed"; daemonRunning: boolean; attached: boolean; recovery?: string | undefined }
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
function olderRelease(version: string, than: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)?.slice(1).map(Number)
  const left = parse(version)
  const right = parse(than)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]!
  }
  return false
}

// Security review round 1 of #576, lines approved by fetzy on 2026-09-25: a
// failed install or removal the service manager left half done, a read-back
// that could not be taken, or a daemon this app did not start.

type FailedOutcome = Extract<DaemonServiceOutcome, { ok: false; reason: "failed" }>

function readBackFact(kind: string, action: "install" | "remove", service: FailedOutcome["service"]): string {
  if (!service || service.installed === null) return `Whether the ${kind} is installed is not known from here.`
  if (action === "install") return service.installed ? `The ${kind} is installed${service.running ? " and running" : " but not running"}.` : "Nothing was installed."
  return service.installed ? `The ${kind} is still installed ${service.running ? "and running" : "but not running"}.` : `The ${kind} is gone, but the removal did not finish.`
}

function daemonFact(daemon: FailedOutcome["daemon"]): string {
  if (daemon === "restarted") return "The daemon is running inside this app again."
  if (daemon === "attached") return "This app is connected to a daemon it did not start."
  if (daemon === "stopped") return "No daemon is running for this app, so no session is running. Quit and reopen Domovoi to start it."
  return "The daemon inside this app was not stopped."
}

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

// What is still true after a failed install or removal. The approved lines
// hold only when the service read back afterwards shows nothing changed.
function failedStill(kind: string, action: "install" | "remove", outcome: FailedOutcome): string {
  const service = outcome.service
  if (action === "install" && service?.installed === false && outcome.daemon !== "attached") {
    return outcome.daemon === "restarted"
      ? "The daemon is back inside this app. Nothing else was touched."
      : outcome.daemon === "stopped"
        ? "Nothing was installed. The daemon inside this app stopped and did not start again, so no session is running. Quit and reopen Domovoi to start it."
        : "Nothing was installed."
  }
  if (action === "remove" && service?.installed === true && service.running && outcome.daemon === "untouched") {
    return `Nothing was removed. The ${kind} still holds the daemon, and every session keeps running.`
  }
  return `${readBackFact(kind, action, service)} ${daemonFact(outcome.daemon)}`
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

// `footer` is the design's last row of the card: About this build.
function DaemonSection({ daemon, footer }: { daemon: LocalDaemonDescription & { owner: NonNullable<LocalDaemonDescription["owner"]>; platform: NonNullable<LocalDaemonDescription["platform"]> }; footer?: ReactNode }) {
  const service = loginServices[daemon.platform]
  const [phase, setPhase] = useState<ServicePhase>({ kind: "idle" })
  const live = daemon.service
  const busy = phase.kind === "installing" || phase.kind === "removing"
  const run = async (action: "install" | "remove") => {
    if (!live) return
    setPhase({ kind: action === "install" ? "installing" : "removing" })
    try {
      const outcome = await (action === "install" ? live.install() : live.remove())
      if (outcome.ok) setPhase(action === "install" ? { kind: "installed", target: outcome.target } : { kind: "removed", daemonRunning: outcome.daemonRunning, attached: outcome.daemonAttached === true, recovery: removalRecovery(outcome) })
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
      if (outcome.ok) setPhase({ kind: "updated" })
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
    ...(on ? [{ label: "After a crash", value: "", note: service.crash, item: "" }] : []),
  ]
  const command = unknown ? "domovoid service status" : installed ? "domovoid service remove" : "domovoid service install"
  const lockReason = busy
    ? (phase.kind === "installing" ? "Both wait until the install finishes." : "Both wait until the removal finishes.")
    : installed
      ? "Install is off: the service is already installed."
      : unknown ? "Install and Remove are off: this app did not start that daemon." : "Remove is off: nothing is installed."
  const installLocked = !live || installed || unknown || busy || updating || Boolean(live.refusal)
  const removeLocked = !live || !installed || busy || updating || Boolean(live.refusal)
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
      {serviceBehind ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground">
          <p className="m-0 min-w-0 flex-1">{`The login service runs Domovoi ${daemon.serviceVersion}. This app is ${daemon.appVersion}.`}</p>
          {live?.update ? <Button type="button" variant="outline" size="sm" disabled={busy || updating || Boolean(live.refusal)} onClick={() => void update()}>Update the service</Button> : null}
        </div>
      ) : null}
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
      {phase.kind === "removed" ? (
        <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2 text-[11.5px]" role="status">
          {phase.recovery ? (
            <>
              <span>{phase.recovery}</span>
              <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />{profileRecoverCommand}</span>
            </>
          ) : phase.daemonRunning && !phase.attached ? <span>Removed. Quitting Domovoi now stops the daemon and every session on it.</span> : null}
          {phase.daemonRunning && phase.attached ? <span>{`${phase.recovery ? "" : "Removed. "}This app is connected to a daemon it did not start. Quitting this app leaves it running.`}</span> : null}
          {phase.daemonRunning ? null : <span>{`${phase.recovery ? "" : "Removed. "}The daemon did not start again inside this app, so no session is running. Quit and reopen Domovoi to start it.`}</span>}
        </div>
      ) : null}
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
          <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />domovoid service status</span>
        </div>
      ) : null}
      {phase.kind === "failed" ? (
        <div className="flex flex-col gap-1.5 rounded-md border border-danger-border bg-danger-background px-3 py-2 text-[11.5px] text-danger-foreground" role="alert">
          <span className="font-medium">{phase.header ?? (phase.action === "install" ? "Could not install the service" : "Could not remove the service")}</span>
          <span className="font-machine text-[10.5px] opacity-80">{phase.message}</span>
          <span>{phase.still}</span>
          <span>To finish by hand, run this in a terminal.</span>
          <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />{phase.action === "install" ? "domovoid service install" : "domovoid service remove"}</span>
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
        <Button size="sm" variant="outline" disabled={removeLocked} {...(live ? {} : { title: "Not built yet" })} onClick={() => void run("remove")}>{service.removeLabel}</Button>
        {live?.refusal && !installed && !unknown && !busy ? null : <span className="text-[11px] text-faint">{lockReason}</span>}
      </div>
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
}

function PairingSection({ pairing, readOnly, onOpenFleet }: { pairing: PairingSettings; readOnly: boolean; onOpenFleet: () => void }) {
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
      <PairingCard connected={pairing.connected} readOnly={readOnly} inAppDaemon={pairing.inAppDaemon ?? false} onIssueCode={pairing.onIssueCode} onCopy={pairing.onCopy} />
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
  onUpdateStatus: () => Promise<UpdateStatus>
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

// On its own, About is a card. Inside the daemon card it is that card's last
// row, set off by a rule, as the design draws it.
function AboutBuildSection({ about, inCard = false }: { about: AboutBuild; inCard?: boolean }) {
  const [status, setStatus] = useState<UpdateStatus | undefined>(undefined)
  const { onUpdateStatus } = about
  useEffect(() => {
    let active = true
    onUpdateStatus().then(
      (next) => { if (active) setStatus(next) },
      () => { if (active) setStatus(undefined) },
    )
    return () => { active = false }
  }, [onUpdateStatus])
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
  about?: AboutBuild | undefined
  pairing?: PairingSettings | undefined
  secrets: readonly ProviderSecretStatus[]
  localDaemon?: LocalDaemonDescription
  approvalRules: readonly ApprovalRule[]
  notifications: NotificationPreferences
  onNotificationsChange: (preferences: NotificationPreferences) => void
  clientCapabilities?: WorkspaceClientCapabilities
  onOpenFleet: () => void
  onOpenSkills: () => void
  onOpenAudit: () => void
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
  secrets,
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
  onResetFirstRun,
  onExternalEditorChange,
  onWindowDecorationChange,
  onThemeChange,
}: SettingsShellProps) {
  const editorCapability = externalEditor !== undefined && onExternalEditorChange !== undefined
    ? { editor: externalEditor, onChange: onExternalEditorChange }
    : undefined
  const daemonSection = localDaemon?.owner && localDaemon.platform
    ? { ...localDaemon, owner: localDaemon.owner, platform: localDaemon.platform }
    : undefined
  const decorationCapability = windowDecoration !== undefined
    && activeWindowDecoration !== undefined
    && onWindowDecorationChange !== undefined
    ? { decoration: windowDecoration, active: activeWindowDecoration, onChange: onWindowDecorationChange }
    : undefined

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
          {daemonSection ? <DaemonSection daemon={daemonSection} footer={about ? <AboutBuildSection about={about} inCard /> : undefined} /> : null}

          <section aria-label="Providers and tokens">
            <ProviderSettings providers={providers} secrets={secrets} {...(localDaemon && !daemonSection ? { localDaemon } : {})} />
          </section>

          {about && !daemonSection ? <AboutBuildSection about={about} /> : null}

          {pairing ? <PairingSection pairing={pairing} readOnly={readOnly} onOpenFleet={onOpenFleet} /> : null}

          <section aria-label="Notifications">
            <NotificationSettings
              preferences={notifications}
              onChange={onNotificationsChange}
              {...(clientCapabilities ? { client: clientCapabilities } : {})}
            />
          </section>

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
            <Button variant="ghost" className="h-auto justify-start rounded-none px-[15px] py-3 text-left" onClick={onOpenFleet}>
              <span className="flex flex-col items-start">
                <span>Machines and daemons</span>
                <span className="text-[11px] font-normal text-muted-foreground">Transports, agents installed, and what each one is running.</span>
              </span>
            </Button>
            <Button variant="ghost" className="h-auto justify-start rounded-none border-t px-[15px] py-3 text-left" onClick={onOpenSkills}>
              <span className="flex flex-col items-start">
                <span>Skills</span>
                <span className="text-[11px] font-normal text-muted-foreground">Install sources, signing, and which skills a machine may run.</span>
              </span>
            </Button>
            <Button variant="ghost" className="h-auto justify-start rounded-none border-t px-[15px] py-3 text-left" onClick={onOpenAudit}>
              <span className="flex flex-col items-start">
                <span>Audit log</span>
                <span className="text-[11px] font-normal text-muted-foreground">Who decided what, on which verified device, and what happened next.</span>
              </span>
            </Button>
            {onResetFirstRun ? (
              <Button variant="ghost" className="h-auto justify-start rounded-none border-t px-[15px] py-3 text-left" onClick={onResetFirstRun}>
                First-run setup
              </Button>
            ) : null}
          </div>
        </section>

        <fieldset disabled={readOnly} className="contents">
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
        </fieldset>
      </main>
    </ScrollArea>
  )
}
