import { loginServiceHomePaths, loginServiceTaskName, type ApprovalRule, type ProviderRuntime } from "@getdomovoi/protocol"
import { TerminalIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AppearanceSettings, ExternalEditorSettings, ProviderSettings, type ProviderSecretStatus } from "./provider-settings.js"
import type { WorkspaceTheme } from "./appearance.js"
import type { DaemonServiceOutcome, DesktopExternalEditor, WorkspaceWindowDecoration } from "./desktop-platform.js"
import { NotificationSettings } from "./notification-settings.js"
import type { NotificationPreferences } from "./notification-preferences.js"
import type { WorkspaceClientCapabilities } from "./workspace-platform.js"
import { PermissionRuleSettings } from "./permission-settings.js"


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
    refusal?: string | undefined
  } | undefined
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
  | { kind: "removed"; daemonRunning: boolean; recovery?: string | undefined }
  | { kind: "waits"; refusal: string }
  | { kind: "unchecked"; message: string }
  | { kind: "not-attached"; message: string }
  | { kind: "failed"; action: "install" | "remove"; message: string; still: string }

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

function DaemonSection({ daemon }: { daemon: LocalDaemonDescription & { owner: NonNullable<LocalDaemonDescription["owner"]>; platform: NonNullable<LocalDaemonDescription["platform"]> } }) {
  const service = loginServices[daemon.platform]
  const [phase, setPhase] = useState<ServicePhase>({ kind: "idle" })
  const live = daemon.service
  const busy = phase.kind === "installing" || phase.kind === "removing"
  const run = async (action: "install" | "remove") => {
    if (!live) return
    setPhase({ kind: action === "install" ? "installing" : "removing" })
    try {
      const outcome = await (action === "install" ? live.install() : live.remove())
      if (outcome.ok) setPhase(action === "install" ? { kind: "installed", target: outcome.target } : { kind: "removed", daemonRunning: outcome.daemonRunning, recovery: removalRecovery(outcome) })
      else if (outcome.reason === "refused") setPhase({ kind: "waits", refusal: outcome.message })
      else if (outcome.reason === "check-failed") setPhase({ kind: "unchecked", message: outcome.message })
      else if (outcome.reason === "installed-not-attached") setPhase({ kind: "not-attached", message: outcome.message })
      else setPhase({ kind: "failed", action, message: outcome.message, still: outcome.reason === "runtime-missing"
        ? "No service was installed and no service files were changed."
        : outcome.reason === "busy" ? "Nothing changed." : action === "install"
          ? (outcome.daemon === "restarted"
            ? "The daemon is back inside this app. Nothing else was touched."
            : outcome.daemon === "stopped"
              ? "Nothing was installed. The daemon inside this app stopped and did not start again, so no session is running. Quit and reopen Domovoi to start it."
              : "Nothing was installed.")
          : `Nothing was removed. The ${service.kind} still holds the daemon, and every session keeps running.` })
    } catch (cause) {
      setPhase({ kind: "failed", action, message: cause instanceof Error ? cause.message : "The desktop did not answer.", still: "Nothing changed." })
    }
  }
  const on = daemon.owner === "outside" && daemon.serviceInstalled === true
  const unknown = daemon.owner === "outside" && !on
  const serviceBehind = on && daemon.serviceVersion !== undefined && daemon.appVersion !== undefined && olderRelease(daemon.serviceVersion, daemon.appVersion)
  const state = on
    ? { label: "Running", tone: "bg-success", line: "Quitting this app leaves the daemon and its sessions running." }
    : unknown
      ? { label: "Not started here", tone: "bg-faint", line: "A daemon this app did not start. Quitting this app leaves it running." }
      : daemon.owner === "app"
        ? { label: "Off", tone: "bg-faint", line: "Quitting Domovoi stops the daemon and every session on it." }
        : { label: "Off", tone: "bg-faint", line: daemon.detail }
  const facts = [
    { label: "Service", value: service.definition, note: `A ${service.kind}, for your user only.`, item: on ? "written" : "will write" },
    { label: "Record", value: "~/.domovoi/service.json", note: "What Domovoi installed, so removing undoes exactly that.", item: on ? "written" : "will write" },
    ...(on ? [{ label: "After a crash", value: "", note: service.crash, item: "" }] : []),
  ]
  const command = unknown ? "domovoid service status" : on ? "domovoid service remove" : "domovoid service install"
  const lockReason = busy
    ? (phase.kind === "installing" ? "Both wait until the install finishes." : "Both wait until the removal finishes.")
    : unknown
      ? "Install and Remove are off: this app did not start that daemon."
      : on ? "Install is off: the service is already installed." : "Remove is off: nothing is installed."
  const installLocked = !live || on || unknown || busy || Boolean(live.refusal)
  const removeLocked = !live || !on || busy || Boolean(live.refusal)
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
      {serviceBehind ? <p className="m-0 rounded-md border border-warn-border bg-warn-background px-3 py-2 text-[11.5px] text-warn-foreground">{`The login service runs Domovoi ${daemon.serviceVersion}. This app is ${daemon.appVersion}.`}</p> : null}
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
          ) : phase.daemonRunning ? <span>Removed. Quitting Domovoi now stops the daemon and every session on it.</span> : null}
          {phase.daemonRunning ? null : <span>Removed. The daemon did not start again inside this app, so no session is running. Quit and reopen Domovoi to start it.</span>}
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
          <span className="font-medium">{phase.action === "install" ? "Could not install the service" : "Could not remove the service"}</span>
          <span className="font-machine text-[10.5px] opacity-80">{phase.message}</span>
          <span>{phase.still}</span>
          <span>To finish by hand, run this in a terminal.</span>
          <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />{phase.action === "install" ? "domovoid service install" : "domovoid service remove"}</span>
        </div>
      ) : null}
      {unknown ? null : <div className="flex flex-col gap-1.5">
        <span className="text-[10.5px] tracking-[0.13em] text-faint">{on ? "WHAT IT WROTE" : "WHAT TURNING IT ON WRITES"}</span>
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
        {unknown ? <span>This app cannot tell whether that daemon is the installed service. To check by hand, run this in a terminal.</span> : <>
          <span>{on ? "Removing the service from this window is not built yet." : "Installing the service from this window is not built yet."}</span>
          <span>To finish by hand, run this in a terminal.</span>
        </>}
        <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />{command}</span>
      </div> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={installLocked} {...(live ? {} : { title: "Not built yet" })} onClick={() => void run("install")}>Install</Button>
        <Button size="sm" variant="outline" disabled={removeLocked} {...(live ? {} : { title: "Not built yet" })} onClick={() => void run("remove")}>{service.removeLabel}</Button>
        {live?.refusal && !on && !unknown && !busy ? null : <span className="text-[11px] text-faint">{lockReason}</span>}
      </div>
    </section>
  )
}

export type SettingsShellProps = {
  providers: readonly ProviderRuntime[]
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
          {daemonSection ? <DaemonSection daemon={daemonSection} /> : null}

          <section aria-label="Providers and tokens">
            <ProviderSettings providers={providers} secrets={secrets} {...(localDaemon && !daemonSection ? { localDaemon } : {})} />
          </section>

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
