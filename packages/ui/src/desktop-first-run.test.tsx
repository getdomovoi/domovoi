import type { ProviderFailure, ProviderRuntime, SessionSummary } from "@getdomovoi/protocol"
import { Children, isValidElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import {
  desktopFirstRunAvailable,
  DesktopFirstRunDialog,
  firstRunFailureForProvider,
  FirstRunSetupSteps,
  providerFirstRunRecovery,
} from "./desktop-first-run.js"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.js"

const ready: ProviderRuntime = {
  id: "codex",
  command: "codex",
  status: "ready",
  version: "0.149.0",
  sessionCapable: true,
}

const failure = (kind: ProviderFailure["kind"]): ProviderFailure => {
  const failures = {
    "authentication-expired": { kind: "authentication-expired", action: "sign-in", message: "Provider authentication expired", retryable: false },
    "rate-limit": { kind: "rate-limit", action: "retry", message: "Provider rate limit reached", retryable: true },
    "quota-exhausted": { kind: "quota-exhausted", action: "check-quota", message: "Provider quota is exhausted", retryable: false },
    "model-unavailable": { kind: "model-unavailable", action: "change-model", message: "Selected model is unavailable", retryable: false },
    "context-window-exceeded": { kind: "context-window-exceeded", action: "shorten-context", message: "Turn exceeded the model context window", retryable: false },
    transport: { kind: "transport", action: "retry", message: "Provider connection failed", retryable: true },
    unknown: { kind: "unknown", action: "retry", message: "Provider request failed", retryable: true },
  } as const satisfies Record<ProviderFailure["kind"], ProviderFailure>
  return failures[kind]
}

describe("desktop first-run provider diagnostics", () => {
  it.each([
    [ready, undefined, "ready", true],
    [{ ...ready, status: "missing" }, undefined, "cli-missing", false],
    [{ ...ready, status: "auth-required" }, undefined, "authentication-required", false],
    [ready, failure("authentication-expired"), "authentication-expired", false],
    [ready, failure("rate-limit"), "rate-limited", false],
    [ready, failure("quota-exhausted"), "quota-exhausted", false],
    [ready, failure("model-unavailable"), "model-access-missing", false],
    [ready, failure("transport"), "retryable-error", false],
    [ready, failure("unknown"), "retryable-error", false],
    [{ ...ready, status: "unknown" }, undefined, "retryable-error", false],
    [{ ...ready, sessionCapable: false }, undefined, "adapter-unavailable", false],
  ] as const)("maps daemon truth to %s recovery", (provider, providerFailure, kind, canComplete) => {
    expect(providerFirstRunRecovery(provider, providerFailure)).toMatchObject({ kind, canComplete })
  })

  it("provides a bounded action for every non-ready state", () => {
    expect(providerFirstRunRecovery({ ...ready, status: "missing" })).toMatchObject({
      description: expect.stringContaining("provider's platform instructions"),
      copyGuidance: "codex",
      copyLabel: "Copy CLI name",
    })
    expect(providerFirstRunRecovery({ ...ready, status: "auth-required" })).toMatchObject({
      description: expect.stringContaining("provider-owned sign-in command"),
      copyGuidance: "codex login",
    })
    expect(providerFirstRunRecovery(ready, failure("authentication-expired"))).toMatchObject({
      title: "Provider authentication expired",
      copyGuidance: "codex login",
    })
    expect(providerFirstRunRecovery(ready, failure("rate-limit")).description).toContain("provider cooldown")
    expect(providerFirstRunRecovery(ready, failure("quota-exhausted")).description).toContain("quota or billing")
    expect(providerFirstRunRecovery(ready, failure("model-unavailable")).description).toContain("available model")
    expect(providerFirstRunRecovery(ready, failure("transport")).description).toContain("provider connection")
    expect(providerFirstRunRecovery(ready, failure("unknown")).description).toContain("Retry diagnostics")
  })

  it("uses only the latest matching session failure", () => {
    const sessions = [
      {
        id: "older",
        runtime: { provider: "codex" },
        updatedAt: "2026-08-30T10:00:00.000Z",
        providerFailure: failure("quota-exhausted"),
      },
      {
        id: "other-provider",
        runtime: { provider: "claude-code" },
        updatedAt: "2026-08-30T12:00:00.000Z",
        providerFailure: failure("authentication-expired"),
      },
      {
        id: "newer",
        runtime: { provider: "codex" },
        updatedAt: "2026-08-30T11:00:00.000Z",
        providerFailure: failure("rate-limit"),
      },
    ] as SessionSummary[]

    expect(firstRunFailureForProvider("codex", sessions)?.kind).toBe("rate-limit")
  })

  it("renders the signed three-step layout with provider selection and Build manual default", () => {
    const markup = renderToStaticMarkup(
      <FirstRunSetupSteps
        connected
        machine={{ name: "devbox", platform: "linux", version: "0.0.1" }}
        providers={[ready, { ...ready, id: "claude-code", command: "claude" }]}
        sessions={[]}
        selectedProviderId="codex"
        permissionMode="build"
        refreshing={false}
        recoveryError=""
        onProviderChange={vi.fn()}
        onPermissionModeChange={vi.fn()}
        onRetry={vi.fn()}
        onCopyGuidance={vi.fn()}
      />,
    )

    expect(markup).toContain("Local daemon running")
    expect(markup).toContain("Connect a coding agent")
    expect(markup).toContain("Choose a permission mode for new projects")
    expect(markup.match(/data-first-run-step=/g)).toHaveLength(3)
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain("Codex")
    expect(markup).toContain("Claude Code")
    expect(markup).toContain("Build manual")
    expect(markup).toContain("reads run free; mutations ask")
    expect(markup).not.toMatch(/password|api key|credential input|sudo|brew install|apt install/i)
  })

  it("gates first-run UI on the explicit desktop capability", () => {
    const bridge = {} as Parameters<typeof desktopFirstRunAvailable>[1]
    expect(desktopFirstRunAvailable("desktop", bridge)).toBe(true)
    expect(desktopFirstRunAvailable("web", bridge)).toBe(false)
    expect(desktopFirstRunAvailable("tablet", bridge)).toBe(false)
    expect(desktopFirstRunAvailable("desktop", undefined)).toBe(false)
  })

  it("uses scoped provider credential copy without absolute locality claims", () => {
    const element = DesktopFirstRunDialog({
      open: true,
      connected: true,
      machine: { name: "devbox", platform: "linux", version: "0.0.1" },
      providers: [ready],
      sessions: [],
      selectedProviderId: "codex",
      permissionMode: "build",
      refreshing: false,
      recoveryError: "",
      onProviderChange: vi.fn(),
      onPermissionModeChange: vi.fn(),
      onRetry: vi.fn(),
      onCopyGuidance: vi.fn(),
      onSkip: vi.fn(),
      onComplete: vi.fn(),
    })
    const text: string[] = []
    const visit = (node: ReactNode): void => {
      Children.forEach(node, (child) => {
        if (typeof child === "string" || typeof child === "number") {
          text.push(String(child))
          return
        }
        if (!isValidElement(child)) return
        visit((child.props as { children?: ReactNode }).children)
      })
    }
    visit(element)
    const copy = text.join(" ")

    expect.soft(copy).toContain("Three local setup steps. Provider credentials stay with their CLIs.")
    expect.soft(copy).not.toMatch(
      /\b(?:nothing leaves|everything (?:stays|remains) (?:on|within)|all (?:data|traffic|requests) (?:stays|remain) (?:on|within)|(?:fully|entirely|completely) local)\b/i,
    )
  })

  it("composes the installed Radix Dialog with title, description, and close semantics", () => {
    const element = DesktopFirstRunDialog({
      open: true,
      connected: true,
      machine: { name: "devbox", platform: "linux", version: "0.0.1" },
      providers: [ready],
      sessions: [],
      selectedProviderId: "codex",
      permissionMode: "build",
      refreshing: false,
      recoveryError: "",
      onProviderChange: vi.fn(),
      onPermissionModeChange: vi.fn(),
      onRetry: vi.fn(),
      onCopyGuidance: vi.fn(),
      onSkip: vi.fn(),
      onComplete: vi.fn(),
    })
    const types: unknown[] = []
    const visit = (node: ReactNode): void => {
      Children.forEach(node, (child) => {
        if (!isValidElement(child)) return
        types.push(child.type)
        visit((child.props as { children?: ReactNode }).children)
      })
    }
    visit(element)

    expect(element.type).toBe(Dialog)
    expect(types).toEqual(expect.arrayContaining([
      DialogContent,
      DialogTitle,
      DialogDescription,
      DialogClose,
    ]))
  })
})
