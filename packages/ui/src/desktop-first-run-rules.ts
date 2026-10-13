import type {
  ClientKind,
  ProviderFailure,
  ProviderRuntime,
  SessionSummary,
} from "@getdomovoi/protocol"

import type { DesktopWindowBridge } from "./desktop-platform.js"
import { providerAccountCommand, providerDisplayName } from "./runtime.js"

// What first-run setup decides, apart from what it draws. The shell runs these
// at launch; the setup dialog itself loads only when it opens
// (desktop-first-run-lazy.tsx).

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

// The copy action, only when Domovoi knows the CLI's own sign-in command
// (review P3-9).
function signInCopy(provider: ProviderRuntime): Pick<ProviderFirstRunRecovery, "copyGuidance" | "copyLabel"> {
  const command = providerAccountCommand(provider)
  return command ? { copyGuidance: command, copyLabel: "Copy sign-in command" } : {}
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
      ...signInCopy(provider),
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
        ...signInCopy(provider),
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
