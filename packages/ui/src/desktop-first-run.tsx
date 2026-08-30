import type {
  ClientKind,
  PermissionMode,
  ProviderFailure,
  ProviderRuntime,
  SessionSummary,
} from "@getdomovoi/protocol"
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CopyIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { DesktopWindowBridge } from "./desktop-platform.js"
import { DomovoiMark } from "./domovoi-mark.js"
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
  if (provider.status === "missing") {
    return {
      kind: "cli-missing",
      title: `${providerDisplayName(provider.id)} CLI is not installed`,
      description: "Install it using the provider's platform instructions, then retry diagnostics. Domovoi will not run an installer for you.",
      canComplete: false,
      copyGuidance: provider.command,
      copyLabel: "Copy CLI name",
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
  if (!provider.sessionCapable) {
    return {
      kind: "adapter-unavailable",
      title: "Provider adapter is unavailable",
      description: "This Domovoi build detected the CLI but cannot start sessions with it. Choose another provider or update Domovoi.",
      canComplete: false,
    }
  }
  if (failure?.kind === "authentication-expired") {
    return {
      kind: "authentication-expired",
      title: failure.message,
      description: "Run the provider-owned sign-in command in a terminal on this machine, then retry diagnostics.",
      canComplete: false,
      copyGuidance: providerAccountCommand(provider),
      copyLabel: "Copy sign-in command",
    }
  }
  if (failure?.kind === "rate-limit") {
    return {
      kind: "rate-limited",
      title: failure.message,
      description: "Wait for the provider cooldown, then retry diagnostics. Domovoi cannot bypass provider limits.",
      canComplete: false,
    }
  }
  if (failure?.kind === "quota-exhausted") {
    return {
      kind: "quota-exhausted",
      title: failure.message,
      description: "Review quota or billing in the provider account, then retry diagnostics. No credential is stored here.",
      canComplete: false,
    }
  }
  if (failure?.kind === "model-unavailable") {
    return {
      kind: "model-access-missing",
      title: failure.message,
      description: "Restore access to that model or choose an available model after setup, then retry diagnostics.",
      canComplete: false,
    }
  }
  if (failure?.kind === "transport" || failure?.kind === "unknown") {
    return {
      kind: "retryable-error",
      title: failure.message,
      description: failure.kind === "transport"
        ? "Restore the provider connection, then retry diagnostics."
        : "Retry diagnostics. If the provider still cannot be verified, review Provider settings.",
      canComplete: false,
    }
  }
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

type FirstRunSetupStepsProps = {
  connected: boolean
  machine?: {
    name: string
    platform: string
    version: string
  }
  providers: readonly ProviderRuntime[]
  sessions: readonly SessionSummary[]
  selectedProviderId: string
  permissionMode: PermissionMode
  refreshing: boolean
  recoveryError: string
  onProviderChange: (providerId: string) => void
  onPermissionModeChange: (permissionMode: PermissionMode) => void
  onRetry: () => void
  onCopyGuidance: (value: string) => void
}

const permissionOptions: readonly { value: PermissionMode; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "plan", label: "Plan" },
  { value: "build", label: "Build manual" },
]

export function FirstRunSetupSteps({
  connected,
  machine,
  providers,
  sessions,
  selectedProviderId,
  permissionMode,
  refreshing,
  recoveryError,
  onProviderChange,
  onPermissionModeChange,
  onRetry,
  onCopyGuidance,
}: FirstRunSetupStepsProps) {
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId)
  const recovery = selectedProvider
    ? providerFirstRunRecovery(
        selectedProvider,
        firstRunFailureForProvider(selectedProvider.id, sessions),
      )
    : undefined

  return (
    <div className="mt-6 flex flex-col gap-2.5">
      <Card data-first-run-step="daemon" size="sm" className="gap-0 py-0">
        <CardHeader className="min-h-16 content-center py-3.5">
          <div className="flex items-center gap-3">
            <Badge variant={connected ? "success" : "secondary"} className="size-5.5 px-0 font-machine">1</Badge>
            <div className="min-w-0 flex-1">
              <CardTitle>{connected ? "Local daemon running" : "Local daemon unavailable"}</CardTitle>
              <CardDescription>
                {connected && machine
                  ? `${machine.name} · ${machine.platform} · daemon ${machine.version}`
                  : "Waiting for a verified response from the local daemon."}
              </CardDescription>
            </div>
            <div className="shrink-0">
              {connected ? (
                <Badge variant="success"><CheckCircle2Icon />Healthy</Badge>
              ) : (
                <Button size="sm" variant="destructive" disabled={refreshing} onClick={onRetry}>
                  <RefreshCwIcon data-icon="inline-start" />
                  {refreshing ? "Retrying" : "Retry"}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

      <Card data-first-run-step="provider" size="sm" className="gap-0 py-0">
        <CardHeader className="min-h-16 content-center py-3.5">
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="size-5.5 px-0 font-machine">2</Badge>
            <div className="min-w-0 flex-1">
              <CardTitle>Connect a coding agent</CardTitle>
              <CardDescription>
                {providers.length > 0
                  ? `${providers.length} provider ${providers.length === 1 ? "runtime" : "runtimes"} reported by this daemon.`
                  : "Provider readiness has not been reported by this daemon yet."}
              </CardDescription>
            </div>
            <Button className="shrink-0" size="sm" variant="outline" disabled={!connected || refreshing} onClick={onRetry}>
              <RefreshCwIcon data-icon="inline-start" className={refreshing ? "motion-safe:animate-spin" : undefined} />
              {refreshing ? "Refreshing" : "Retry diagnostics"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pb-3.5">
          {providers.length > 0 ? (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={selectedProviderId}
              aria-label="Default coding agent"
              disabled={!connected || refreshing}
              className="flex-wrap justify-start"
              onValueChange={(value) => {
                if (providers.some((provider) => provider.id === value)) onProviderChange(value)
              }}
            >
              {providers.map((provider) => (
                <ToggleGroupItem key={provider.id} value={provider.id}>
                  {providerDisplayName(provider.id)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
        </CardContent>
        {recovery ? (
          <CardFooter className="flex-col items-start gap-2">
            <div role="status" className="flex items-center gap-2">
              <Badge variant={recovery.kind === "ready" ? "success" : "warning"}>
                {recovery.kind === "ready" ? "Ready" : "Recovery needed"}
              </Badge>
              <span className="font-medium">{recovery.title}</span>
            </div>
            <p className="m-0 text-sm text-muted-foreground">{recovery.description}</p>
            {recovery.copyGuidance ? (
              <Button size="xs" variant="outline" onClick={() => onCopyGuidance(recovery.copyGuidance!)}>
                <CopyIcon data-icon="inline-start" />
                {recovery.copyLabel}
              </Button>
            ) : null}
          </CardFooter>
        ) : null}
      </Card>
      {recoveryError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Diagnostics could not be refreshed</AlertTitle>
          <AlertDescription>{recoveryError}</AlertDescription>
        </Alert>
      ) : null}

      <Card data-first-run-step="permission" size="sm" className="gap-0 py-0">
        <CardHeader className="min-h-16 content-center py-3.5">
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="size-5.5 px-0 font-machine">3</Badge>
            <div className="min-w-0 flex-1">
              <CardTitle>Choose a permission mode for new projects</CardTitle>
              <CardDescription>Build manual is the default: reads run free; mutations ask.</CardDescription>
            </div>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={permissionMode}
              aria-label="Default permission mode"
              onValueChange={(value) => {
                if (value === "ask" || value === "plan" || value === "build") {
                  onPermissionModeChange(value)
                }
              }}
            >
              {permissionOptions.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </CardHeader>
      </Card>
    </div>
  )
}

export type DesktopFirstRunDialogProps = FirstRunSetupStepsProps & {
  open: boolean
  onSkip: () => void
  onComplete: () => void
}

export function DesktopFirstRunDialog({
  open,
  connected,
  machine,
  providers,
  sessions,
  selectedProviderId,
  permissionMode,
  refreshing,
  recoveryError,
  onProviderChange,
  onPermissionModeChange,
  onRetry,
  onCopyGuidance,
  onSkip,
  onComplete,
}: DesktopFirstRunDialogProps) {
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId)
  const ready = connected && selectedProvider !== undefined && providerFirstRunRecovery(
    selectedProvider,
    firstRunFailureForProvider(selectedProvider.id, sessions),
  ).canComplete

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onSkip() }}>
      <DialogContent
        showCloseButton={false}
        className="h-dvh max-h-none max-w-none place-items-center overflow-y-auto rounded-none bg-code p-4 sm:max-w-none"
      >
        <div className="w-full max-w-[720px] py-6">
          <div className="flex items-center gap-2.5">
            <DomovoiMark className="size-7 text-primary" />
            <span className="text-[17px] font-semibold">Domovoi</span>
            <span className="flex-1" />
            <DialogClose asChild>
              <Button variant="ghost">Skip for now</Button>
            </DialogClose>
          </div>
          <DialogHeader className="mt-6 gap-2.5 text-left">
            <DialogTitle className="text-[26px] font-semibold tracking-[-0.02em]">
              A good spirit lives in your machines.
            </DialogTitle>
            <DialogDescription className="max-w-[520px] text-[13px] leading-relaxed">
              Three steps and nothing leaves this computer. You can add remote machines later.
            </DialogDescription>
          </DialogHeader>
          <FirstRunSetupSteps
            connected={connected}
            {...(machine ? { machine } : {})}
            providers={providers}
            sessions={sessions}
            selectedProviderId={selectedProviderId}
            permissionMode={permissionMode}
            refreshing={refreshing}
            recoveryError={recoveryError}
            onProviderChange={onProviderChange}
            onPermissionModeChange={onPermissionModeChange}
            onRetry={onRetry}
            onCopyGuidance={onCopyGuidance}
          />
          <div className="mt-5 flex items-center gap-3">
            <p className="m-0 flex-1 text-[11px] leading-relaxed text-faint">
              Provider credentials remain owned by their CLI. Domovoi stores only this setup completion and your defaults.
            </p>
            <Button disabled={!ready || refreshing} onClick={onComplete}>
              Finish setup · {permissionMode === "build" ? "Build manual" : permissionMode === "plan" ? "Plan" : "Ask"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
