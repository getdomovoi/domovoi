import type {
  ClientKind,
  PermissionMode,
  ProviderFailure,
  ProviderRuntime,
  SessionSummary,
} from "@getdomovoi/protocol"
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  RefreshCwIcon,
} from "lucide-react"
import { useContext, useEffect, useRef, useState, type ReactNode } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import type { DaemonServiceOutcome, DesktopWindowBridge } from "./desktop-platform.js"
import { browserDesktopFirstRunStorage, rememberDesktopFirstRunDismissed } from "./desktop-first-run-persistence.js"
import { FirstRunServiceContext, type FirstRunService } from "./desktop-first-run-service.js"
import { DomovoiMark } from "./domovoi-mark.js"
import { failedStill, loginServices, type LoginServicePlatform } from "./login-service-copy.js"
import { providerAccountCommand } from "./provider-settings.js"
import { providerDisplayName } from "./runtime.js"

export type ProviderFirstRunRecovery = {
  kind:
    | "ready"
    | "cli-missing"
    | "authentication-required"
    | "authentication-expired"
    | "rate-limited"
    | "quota-exhausted"
    | "model-access-missing"
    | "retryable-error"
    | "adapter-unavailable"
    | "approval-answered-elsewhere"
  title: string
  description: string
  canComplete: boolean
  copyGuidance?: string
  copyLabel?: string
}

export function desktopFirstRunAvailable(
  clientKind: ClientKind,
  windowBridge: DesktopWindowBridge | undefined,
): boolean {
  return clientKind === "desktop" && windowBridge !== undefined
}

export function firstRunFailureForProvider(
  providerId: string,
  sessions: readonly SessionSummary[],
): ProviderFailure | undefined {
  return sessions
    .filter((session) =>
      session.runtime.provider === providerId && session.providerFailure !== undefined
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    ?.providerFailure
}

export function providerFirstRunRecovery(
  provider: ProviderRuntime,
  failure?: ProviderFailure,
): ProviderFirstRunRecovery {
  // Q353 A: guidance only. Domovoi never installs an agent, so nothing here
  // reads as an install command.
  if (provider.status === "missing") {
    return {
      kind: "cli-missing",
      title: "Not installed here",
      description: `Install it with the provider's own instructions so that ${provider.command} is on the PATH the daemon searches, then press Retry diagnostics.`,
      canComplete: false,
    }
  }
  if (provider.status === "auth-required") {
    const expired = failure?.kind === "authentication-expired"
    return {
      kind: expired ? "authentication-expired" : "authentication-required",
      title: expired ? "Provider authentication expired" : `${providerDisplayName(provider.id)} sign-in required`,
      description: "Run the provider-owned sign-in command in a terminal on this machine, then retry diagnostics.",
      canComplete: false,
      copyGuidance: providerAccountCommand(provider),
      copyLabel: "Copy sign-in command",
    }
  }
  if (provider.problem !== undefined) {
    return {
      kind: "adapter-unavailable",
      title: `${providerDisplayName(provider.id)} cannot start sessions`,
      description: provider.problem,
      canComplete: false,
    }
  }
  if (!provider.sessionCapable) {
    return {
      kind: "adapter-unavailable",
      title: "Provider adapter is unavailable",
      description: "This Domovoi build detected the CLI but cannot start sessions with it. Choose another provider or update Domovoi.",
      canComplete: false,
    }
  }
  const failed = failure === undefined ? undefined : failureRecovery(provider, failure)
  if (failed) return failed
  if (provider.status === "unknown") {
    return {
      kind: "retryable-error",
      title: "Provider status could not be verified",
      description: "Retry diagnostics. If status remains unknown, run the provider's status command from Provider settings.",
      canComplete: false,
    }
  }
  return {
    kind: "ready",
    title: `${providerDisplayName(provider.id)} is ready`,
    description: "The daemon verified the CLI and its provider-owned authentication on this machine.",
    canComplete: true,
  }
}

// Review P2-3: the agent setup records as the default for new sessions. Only
// an agent whose diagnostics are ready qualifies: the one already chosen if
// it is ready, else Codex if it is ready, else the first ready one.
export function firstRunDefaultProvider(
  providers: readonly ProviderRuntime[],
  sessions: readonly SessionSummary[],
  chosenId?: string,
): ProviderRuntime | undefined {
  const ready = providers.filter((provider) =>
    providerFirstRunRecovery(provider, firstRunFailureForProvider(provider.id, sessions)).canComplete
  )
  return ready.find((provider) => provider.id === chosenId)
    ?? ready.find((provider) => provider.id === "codex")
    ?? ready[0]
}

// One case per failure kind, so a kind added to the protocol fails typecheck
// here instead of reading as a ready provider. Undefined only for a failure
// that says nothing about the provider's setup.
function failureRecovery(
  provider: ProviderRuntime,
  failure: ProviderFailure,
): ProviderFirstRunRecovery | undefined {
  switch (failure.kind) {
    case "authentication-expired":
      return {
        kind: "authentication-expired",
        title: failure.message,
        description: "Run the provider-owned sign-in command in a terminal on this machine, then retry diagnostics.",
        canComplete: false,
        copyGuidance: providerAccountCommand(provider),
        copyLabel: "Copy sign-in command",
      }
    case "rate-limit":
      return {
        kind: "rate-limited",
        title: failure.message,
        description: "Wait for the provider cooldown, then retry diagnostics. Domovoi cannot bypass provider limits.",
        canComplete: false,
      }
    case "quota-exhausted":
      return {
        kind: "quota-exhausted",
        title: failure.message,
        description: "Review quota or billing in the provider account, then retry diagnostics. No credential is stored here.",
        canComplete: false,
      }
    case "model-unavailable":
      return {
        kind: "model-access-missing",
        title: failure.message,
        description: "Restore access to that model or choose an available model after setup, then retry diagnostics.",
        canComplete: false,
      }
    case "transport":
    case "unknown":
      return {
        kind: "retryable-error",
        title: failure.message,
        description: failure.kind === "transport"
          ? "Restore the provider connection, then retry diagnostics."
          : "Retry diagnostics. If the provider still cannot be verified, review Provider settings.",
        canComplete: false,
      }
    // The daemon stopped a session whose approval was answered by something
    // else holding the provider server's password (ruling Q243 A).
    case "approval-answered-elsewhere":
      return {
        kind: "approval-answered-elsewhere",
        title: failure.message,
        description: "A program on this machine used the provider server's password to answer an approval, so Domovoi stopped that session. What it approved may have run. Review the changes in that session's worktree before you continue it.",
        canComplete: false,
      }
    // A turn too long for the model says nothing about the provider's setup.
    case "context-window-exceeded":
      return undefined
    default:
      return failure satisfies never
  }
}

type FirstRunMachine = {
  name: string
  platform: string
  version: string
}

// The v2 Onboarding design (2026-09-23), recreated for the desktop as ruled
// on 2026-10-02: Q351 A starts at its step 2, keeping Domovoi running after
// quit, because the daemon ships inside the app and step 1 cannot happen; the
// account step is M2 work and is not drawn; Q352 A drops the permission-mode
// step, so new sessions start in Build manual; Q353 A draws one card per agent
// whose action copies the provider CLI's own sign-in command. Adding another
// machine and opening a repository are reached from the workspace after setup.

// The commands each platform's step names come from the daemon's installer
// (service/install.ts) and the desktop's runtime copy (daemon-service.ts).
function installRows(platform: LoginServicePlatform): { label: string; detail: string }[] {
  const service = loginServices[platform]
  const runtime = { label: "Copy this app's daemon runtime", detail: "~/.domovoi/runtime, so the service never runs from inside the app" }
  const record = { label: "Write the service record", detail: "~/.domovoi/service.json" }
  const hand = { label: `Hand this app's daemon to ${service.manager}`, detail: `the daemon stops here and ${service.manager} starts it` }
  const attach = { label: "Attach this app to the service", detail: "over loopback" }
  if (platform === "darwin") return [runtime, { label: "Write the LaunchAgent", detail: service.definition }, record, hand, attach]
  if (platform === "linux") {
    return [runtime, { label: "Write the systemd user unit", detail: service.definition }, record, { label: "Turn on lingering", detail: "loginctl enable-linger · keeps it running after you log out" }, hand, attach]
  }
  return [runtime, { label: "Register the logon task", detail: service.definition }, record, hand, attach]
}

const doneLines: Record<LoginServicePlatform, string> = {
  darwin: "Domovoi is running as a login service. It starts when you log in. It answers on loopback only.",
  linux: "Domovoi is running as a login service. It starts when you log in. It answers on loopback only.",
  win32: "Domovoi is running as a login service. It starts when you sign in. It answers on loopback only.",
}

type ServicePhase =
  | { kind: "idle"; waits?: string }
  | { kind: "installing" }
  | { kind: "done"; lingerWarning?: string | undefined }
  | { kind: "not-attached"; message: string }
  | { kind: "failed"; what: string; message: string; still: string }

function phaseAfter(outcome: DaemonServiceOutcome, platform: LoginServicePlatform): ServicePhase {
  const service = loginServices[platform]
  if (outcome.ok) return { kind: "done", lingerWarning: outcome.lingerWarning }
  if (outcome.reason === "refused" || outcome.reason === "busy") return { kind: "idle", waits: `The install waits: ${outcome.message} Nothing is interrupted.` }
  if (outcome.reason === "check-failed") return { kind: "idle", waits: "Could not check for running turns or waiting gates, so the install waits. Nothing is interrupted." }
  if (outcome.reason === "installed-not-attached") return { kind: "not-attached", message: outcome.message }
  if (outcome.reason === "runtime-missing") return { kind: "failed", what: "Domovoi could not install the service.", message: outcome.message, still: "No service was installed and no service files were changed." }
  if (outcome.reason === "update-failed") return { kind: "failed", what: "Domovoi could not install the service.", message: outcome.message, still: "Nothing changed." }
  return { kind: "failed", what: `Domovoi could not install the ${service.kind}.`, message: outcome.message, still: failedStill(service.kind, "install", outcome) }
}

function StepMark({ tone, children }: { tone: "done" | "none"; children: ReactNode }) {
  const color = tone === "done" ? "bg-success/18 text-success" : "bg-muted text-muted-foreground"
  return <span aria-hidden className={`flex size-[19px] shrink-0 items-center justify-center rounded-full font-machine text-[10.5px] ${color}`}>{children}</span>
}

function ServiceStep({ service, machine, phase, onInstall, onContinue }: {
  service: FirstRunService
  machine?: FirstRunMachine | undefined
  phase: ServicePhase
  onInstall: () => void
  onContinue: () => void
}) {
  const platform = service.platform
  const rows = installRows(platform)
  const title = phase.kind === "installing" ? "Installing the login service"
    : phase.kind === "done" ? "The service is installed"
      : phase.kind === "failed" ? "The service was not installed"
        : phase.kind === "not-attached" ? "The service is installed, but this window could not reach it"
          : "Keep Domovoi running after you quit"
  const subtitle = phase.kind === "installing" ? "The window says what happened when it finishes. Nothing else changes while it runs."
    : phase.kind === "done" ? "This app is now a client of the service, not the host of the daemon."
      : phase.kind === "failed" ? "Settings shows the service's state and can try again."
        : phase.kind === "not-attached" ? `The ${loginServices[platform].kind} is installed and the daemon inside this app is stopped. Whether the service started is not known from here.`
          : "The daemon lives inside this app for now, so quitting it stops every session. The service moves it under your login."
  // The desktop reports only the final outcome, not which action failed, so
  // a failure marks no row; the daemon's own error names the step.
  const cardTitle = phase.kind === "installing" ? "Running now" : phase.kind === "done" || phase.kind === "not-attached" ? "What it did" : "What installing does"
  const markFor = (index: number) => {
    if (phase.kind === "done" || phase.kind === "not-attached") return { tone: "done" as const, glyph: <CheckIcon className="size-3" /> }
    return { tone: "none" as const, glyph: String(index + 1) }
  }
  return (
    <div className="my-auto flex w-full max-w-[660px] flex-col gap-5 py-12">
      <div className="flex flex-col gap-2">
        <DialogTitle asChild><h2 className="m-0 text-[21px] font-semibold tracking-[-0.015em]">{title}</h2></DialogTitle>
        <DialogDescription className="m-0 text-[13px] leading-[1.65] text-muted-foreground">{subtitle}</DialogDescription>
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-center gap-2.5 border-b px-[15px] py-[11px]">
          <span id="first-run-service-rows" className="text-[12.5px] font-medium">{cardTitle}</span>
          <span className="flex-1" />
          <span className="text-[11.5px] text-muted-foreground">For your user only. Nothing is system-wide.</span>
        </div>
        <ul aria-labelledby="first-run-service-rows" className="m-0 list-none p-0">
          {rows.map((row, index) => {
            const mark = markFor(index)
            return (
              <li key={row.label} className={`flex items-center gap-[11px] px-[15px] py-[11px]${index ? " border-t" : ""}`}>
                <StepMark tone={mark.tone}>{mark.glyph}</StepMark>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px]">{row.label}</div>
                  <div className="mt-[3px] font-machine text-[10.5px] text-faint">{row.detail}</div>
                </div>
                {phase.kind === "installing" && index === 0 ? <span aria-hidden className="h-[3px] w-[34px] animate-pulse rounded-full bg-primary" /> : null}
              </li>
            )
          })}
        </ul>
      </div>
      {phase.kind === "done" ? (
        <div role="status" className="flex items-start gap-[11px] rounded-lg border border-ok-border bg-ok-background px-[15px] py-[13px] text-[12.5px] leading-[1.6] text-ok-foreground">
          <span aria-hidden className="mt-1.5 size-[7px] shrink-0 rounded-full bg-success" />
          <span>{doneLines[platform]}</span>
        </div>
      ) : null}
      {phase.kind === "done" && phase.lingerWarning ? (
        <div role="status" className="flex items-start gap-[11px] rounded-lg border border-info-border bg-info-background px-[15px] py-[13px] text-[12.5px] leading-[1.6] text-info-foreground">
          <span aria-hidden className="mt-1.5 size-[7px] shrink-0 rounded-full bg-info" />
          <span>{phase.lingerWarning}</span>
        </div>
      ) : null}
      {phase.kind === "not-attached" ? (
        <p role="alert" className="m-0 rounded-lg border border-warn-border bg-warn-background px-[15px] py-[13px] font-machine text-[10.5px] text-warn-foreground">{phase.message}</p>
      ) : null}
      {phase.kind === "failed" ? (
        <div role="alert" className="overflow-hidden rounded-lg border border-danger-border bg-danger-background text-danger-foreground">
          <div className="flex flex-col gap-1.5 px-[15px] py-[13px]">
            <span className="text-[10.5px] font-medium tracking-[0.13em] text-danger-dim">WHAT FAILED</span>
            <span className="text-[12.5px] leading-[1.6]">{phase.what}</span>
            <span className="font-machine text-[10.5px] text-danger-dim">{phase.message}</span>
          </div>
          <div className="flex flex-col gap-1.5 border-t border-danger-border px-[15px] py-[13px]">
            <span className="text-[10.5px] font-medium tracking-[0.13em] text-danger-dim">WHAT STILL WORKS</span>
            <span className="text-[12.5px] leading-[1.6]">{phase.still}</span>
          </div>
        </div>
      ) : null}
      {phase.kind === "idle" && phase.waits ? (
        <p role="status" className="m-0 rounded-lg border border-warn-border bg-warn-background px-[15px] py-[13px] text-[12.5px] text-warn-foreground">{phase.waits}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {phase.kind === "done" || phase.kind === "not-attached" ? (
          <Button onClick={onContinue}>Connect an agent</Button>
        ) : (
          <Button disabled={phase.kind === "installing"} onClick={onInstall}>{phase.kind === "failed" ? "Try again" : "Install the service"}</Button>
        )}
        {phase.kind === "idle" ? <Button variant="outline" onClick={onContinue}>Not now</Button> : null}
        {phase.kind === "failed" ? <Button variant="outline" onClick={onContinue}>Continue without the service</Button> : null}
        <span className="text-[11.5px] text-muted-foreground">
          {phase.kind === "idle" ? "Remove it any time in Settings." : phase.kind === "done" ? "Settings shows its state and can remove it." : ""}
        </span>
      </div>
      {/* scripts/unsigned-build.mjs holds this line to the Settings one. */}
      <div className="flex flex-wrap items-baseline gap-2.5">
        {machine ? <span className="font-machine text-[10.5px] text-faint">{`domovoid ${machine.version}`}</span> : null}
        <span className="text-[11px] text-muted-foreground">This build is not signed and does not update itself.</span>
      </div>
    </div>
  )
}

export type FirstRunAgentsProps = {
  connected: boolean
  machine?: FirstRunMachine | undefined
  providers: readonly ProviderRuntime[]
  sessions: readonly SessionSummary[]
  refreshing: boolean
  recoveryError: string
  onRetry: () => void
  onCopyGuidance: (value: string) => void
}

function agentTone(recovery: ProviderFirstRunRecovery): string {
  if (recovery.kind === "ready") return "bg-success"
  if (recovery.kind === "cli-missing") return "bg-faint"
  return "bg-warning"
}

function AgentCard({ provider, sessions, onCopyGuidance }: { provider: ProviderRuntime; sessions: readonly SessionSummary[]; onCopyGuidance: (value: string) => void }) {
  const recovery = providerFirstRunRecovery(provider, firstRunFailureForProvider(provider.id, sessions))
  const [guide, setGuide] = useState(false)
  const missing = recovery.kind === "cli-missing"
  const version = missing ? "not found" : `${provider.version ?? "version unknown"} · found in PATH`
  const state = missing
    ? "Not installed here. Domovoi will not install agents for you, it only runs what is already on the machine."
    : recovery.kind === "ready" ? "Ready. The daemon verified the CLI and its sign-in on this machine." : `${recovery.title}. ${recovery.description}`
  return (
    <li className={`overflow-hidden rounded-lg border bg-card${missing ? " opacity-70" : ""}${guide ? " border-primary" : ""}`}>
      <div className="flex flex-wrap items-center gap-[11px] px-[15px] py-[13px]">
        <span aria-hidden className={`size-[7px] shrink-0 rounded-full ${agentTone(recovery)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span aria-hidden className="inline-flex size-[18px] shrink-0 items-center justify-center self-center rounded-full border bg-muted font-machine text-[10px] font-medium text-strong">{provider.id.slice(0, 2)}</span>
            <span data-agent-name className="font-machine text-[12.5px]">{provider.id}</span>
            <span className="font-machine text-[10.5px] text-faint">{version}</span>
          </div>
          <div className="mt-1 text-[11.5px] leading-[1.5] text-muted-foreground">{state}</div>
          {recovery.copyGuidance ? <div className="mt-1.5 font-machine text-[11px] text-strong">{recovery.copyGuidance}</div> : null}
        </div>
        {recovery.copyGuidance ? (
          <Button size="sm" variant="secondary" onClick={() => onCopyGuidance(recovery.copyGuidance!)}>
            <CopyIcon data-icon="inline-start" />
            {recovery.copyLabel}
          </Button>
        ) : missing ? (
          <Button size="sm" variant="outline" aria-expanded={guide} onClick={() => setGuide((open) => !open)}>Install guide</Button>
        ) : null}
      </div>
      {missing && guide ? (
        <p className="m-0 mx-[15px] mb-[13px] rounded-md bg-code px-[13px] py-[11px] text-[11.5px] leading-[1.6] text-muted-foreground">{recovery.description}</p>
      ) : null}
    </li>
  )
}

// Inside the setup dialog the heading names the dialog; drawn alone it is a
// plain heading.
export function FirstRunAgents({ connected, machine, providers, sessions, refreshing, recoveryError, onRetry, onCopyGuidance, inDialog = false }: FirstRunAgentsProps & { inDialog?: boolean }) {
  const heading = <h2 className="m-0 text-[21px] font-semibold tracking-[-0.015em]">{`Connect an agent on ${machine?.name ?? "this machine"}`}</h2>
  const description = "Agents you already have. Each agent signs in through its own CLI on this machine, so each machine signs in separately."
  const descriptionClass = "m-0 text-[13px] leading-[1.65] text-muted-foreground"
  return (
    <div className="flex w-full max-w-[760px] flex-col gap-5 py-10">
      <div className="flex flex-col gap-2">
        {inDialog ? <DialogTitle asChild>{heading}</DialogTitle> : heading}
        {inDialog ? <DialogDescription className={descriptionClass}>{description}</DialogDescription> : <p className={descriptionClass}>{description}</p>}
      </div>
      {!connected ? <p className="m-0 text-[12.5px] text-muted-foreground">Waiting for a verified response from the local daemon.</p> : null}
      {providers.length > 0 ? (
        <ul aria-label="Agents on this machine" className="m-0 flex list-none flex-col gap-[11px] p-0">
          {providers.map((provider) => <AgentCard key={provider.id} provider={provider} sessions={sessions} onCopyGuidance={onCopyGuidance} />)}
        </ul>
      ) : connected ? <p className="m-0 text-[12.5px] text-muted-foreground">This daemon has not reported any agents yet.</p> : null}
      {recoveryError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Diagnostics could not be refreshed</AlertTitle>
          <AlertDescription>{recoveryError}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button size="sm" variant="ghost" disabled={refreshing} onClick={onRetry}>
          <RefreshCwIcon data-icon="inline-start" className={refreshing ? "motion-safe:animate-spin" : undefined} />
          {refreshing ? "Refreshing" : "Retry diagnostics"}
        </Button>
      </div>
    </div>
  )
}

export type DesktopFirstRunDialogProps = Omit<FirstRunAgentsProps, "machine"> & {
  open: boolean
  machine?: FirstRunMachine
  selectedProviderId: string
  // Q352 A: setup no longer asks for a permission mode; new sessions start
  // in Build manual and the composer's mode chip changes it. The shell still
  // passes these, so they stay optional and unread.
  permissionMode?: PermissionMode
  onPermissionModeChange?: (permissionMode: PermissionMode) => void
  onProviderChange?: (providerId: string) => void
  onSkip: () => void
  onComplete: () => void
}

type Screen = "service" | "agents"

export function DesktopFirstRunDialog({
  open,
  connected,
  machine,
  providers,
  sessions,
  selectedProviderId,
  refreshing,
  recoveryError,
  onRetry,
  onCopyGuidance,
  onSkip,
  onComplete,
}: DesktopFirstRunDialogProps) {
  const service = useContext(FirstRunServiceContext)
  const offersService = service !== undefined && service.owner === "app"
  const [screen, setScreen] = useState<Screen>(offersService ? "service" : "agents")
  const [phase, setPhase] = useState<ServicePhase>({ kind: "idle" })
  // Opening setup again from Settings starts it from the top.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setScreen(offersService ? "service" : "agents")
      setPhase({ kind: "idle" })
    }
    wasOpen.current = open
  }, [open, offersService])

  const defaultProvider = firstRunDefaultProvider(providers, sessions, selectedProviderId)
  const ready = connected && !refreshing && defaultProvider !== undefined

  // Closing setup is remembered, so it does not open again on every launch.
  // Settings > First-run setup opens it again.
  const dismiss = () => {
    rememberDesktopFirstRunDismissed(browserDesktopFirstRunStorage())
    onSkip()
  }
  // With a ready agent, the shell records it as the default for new sessions.
  // Without one, setup still ends: a new user is never held here.
  const finish = () => {
    if (ready) onComplete()
    else dismiss()
  }
  const install = async () => {
    if (!service) return
    setPhase({ kind: "installing" })
    try {
      setPhase(phaseAfter(await service.install(), service.platform))
    } catch (cause) {
      const kind = loginServices[service.platform].kind
      setPhase({ kind: "failed", what: "Domovoi could not install the service.", message: cause instanceof Error ? cause.message : "The desktop did not answer.", still: `Whether the ${kind} is installed is not known from here.` })
    }
  }
  const showService = screen === "service" && service !== undefined
  const chip = !connected || !machine ? "no daemon"
    : phase.kind === "installing" ? "installing"
      : phase.kind === "done" ? `daemon ${machine.version} · login service`
        : service?.owner === "app" ? `daemon ${machine.version} · in this app` : `daemon ${machine.version}`

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss() }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-dvh max-h-none max-w-none flex-col gap-0 overflow-hidden rounded-none bg-background p-0 sm:max-w-none"
      >
        <div className="flex h-[46px] shrink-0 items-center gap-3 border-b px-3.5">
          <DomovoiMark className="size-[22px] text-primary" />
          <span className="text-[13px] font-semibold tracking-[-0.01em]">Domovoi</span>
          <span aria-hidden className="h-[18px] w-px bg-border" />
          <span className="text-[12px] text-muted-foreground">Setup</span>
          <span className="flex-1" />
          <span className="rounded-full bg-accent px-2 py-0.5 font-machine text-[10.5px] text-muted-foreground">{chip}</span>
          <Button variant="ghost" size="sm" onClick={dismiss}>Skip for now</Button>
        </div>
        <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-6">
          {showService ? (
            <ServiceStep
              service={service}
              machine={machine}
              phase={phase}
              onInstall={() => void install()}
              onContinue={() => setScreen("agents")}
            />
          ) : (
            <div className="flex w-full max-w-[760px] flex-col">
              <FirstRunAgents
                inDialog
                connected={connected}
                machine={machine}
                providers={providers}
                sessions={sessions}
                refreshing={refreshing}
                recoveryError={recoveryError}
                onRetry={onRetry}
                onCopyGuidance={onCopyGuidance}
              />
              <div className="flex flex-wrap items-center gap-2 pb-10">
                <Button disabled={refreshing} onClick={finish}>One machine is enough for now</Button>
                <span className="text-[11.5px] text-muted-foreground">
                  {ready && defaultProvider
                    ? `New sessions start with ${providerDisplayName(defaultProvider.id)} in Build manual. Add machines later from Machines.`
                    : "No agent is ready yet. Setup can end now. Once an agent signs in, new sessions can use it."}
                </span>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
