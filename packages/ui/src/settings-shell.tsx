import { loginServiceHomePaths, loginServiceTaskName, type ApprovalRule, type ClientKind, type PairedDeviceSummary, type ProviderRuntime } from "@getdomovoi/protocol"
import { ChevronRightIcon, TerminalIcon } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { AppearanceSettings, ExternalEditorSettings, ProviderSettings, type ProviderSecretStatus } from "./provider-settings.js"
import type { WorkspaceTheme } from "./appearance.js"
import type { DesktopExternalEditor, WorkspaceWindowDecoration } from "./desktop-platform.js"
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
  platform?: "darwin" | "linux" | "win32" | undefined
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

function DaemonSection({ daemon }: { daemon: LocalDaemonDescription & { owner: NonNullable<LocalDaemonDescription["owner"]>; platform: NonNullable<LocalDaemonDescription["platform"]> } }) {
  const service = loginServices[daemon.platform]
  const on = daemon.owner === "outside" && daemon.serviceInstalled === true
  const unknown = daemon.owner === "outside" && !on
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
  const lockReason = unknown
    ? "Install and Remove are off: this app did not start that daemon."
    : on ? "Install is off: the service is already installed." : "Remove is off: nothing is installed."
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
          <span aria-hidden className={`size-[7px] rounded-full ${state.tone}`} />
          {state.label}
        </span>
      </div>
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
      <div className="flex flex-col gap-1.5 rounded-md border border-info-border bg-info-background px-3 py-2 text-[11.5px] text-info-foreground">
        {unknown ? <span>This app cannot tell whether that daemon is the installed service. To check by hand, run this in a terminal.</span> : <>
          <span>{on ? "Removing the service from this window is not built yet." : "Installing the service from this window is not built yet."}</span>
          <span>To finish by hand, run this in a terminal.</span>
        </>}
        <span className="flex items-center gap-2 font-machine text-[11px]"><TerminalIcon className="size-3.5" />{command}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled title="Not built yet">Install</Button>
        <Button size="sm" variant="outline" disabled title="Not built yet">{service.removeLabel}</Button>
        <span className="text-[11px] text-faint">{lockReason}</span>
      </div>
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

export type SettingsShellProps = {
  providers: readonly ProviderRuntime[]
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
          {daemonSection ? <DaemonSection daemon={daemonSection} /> : null}

          <section aria-label="Providers and tokens">
            <ProviderSettings providers={providers} secrets={secrets} {...(localDaemon && !daemonSection ? { localDaemon } : {})} />
          </section>

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
