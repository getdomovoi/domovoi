import type { ProviderFailure, ProviderRuntime, SessionSummary } from "@getdomovoi/protocol"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import {
  desktopFirstRunAvailable,
  firstRunFailureForProvider,
  FirstRunAgents,
  providerFirstRunRecovery,
} from "./desktop-first-run.js"

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
    "approval-answered-elsewhere": { kind: "approval-answered-elsewhere", action: "review-changes", message: "An approval was answered outside Domovoi", retryable: false },
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
    [ready, failure("approval-answered-elsewhere"), "approval-answered-elsewhere", false],
    // A turn too long for the model says nothing about the provider's setup.
    [ready, failure("context-window-exceeded"), "ready", true],
    [{ ...ready, status: "unknown" }, undefined, "retryable-error", false],
    [{ ...ready, sessionCapable: false }, undefined, "adapter-unavailable", false],
  ] as const)("maps daemon truth to %s recovery", (provider, providerFailure, kind, canComplete) => {
    expect(providerFirstRunRecovery(provider, providerFailure)).toMatchObject({ kind, canComplete })
  })

  it("says why a detected CLI cannot start sessions, in the daemon's words", () => {
    const problem = "Update Claude Code to 2.1.263 or newer. The claude on this machine is 2.1.100."
    expect(providerFirstRunRecovery({ ...ready, id: "claude-code", command: "claude", problem })).toMatchObject({
      kind: "adapter-unavailable",
      title: "Claude Code cannot start sessions",
      description: problem,
      canComplete: false,
    })
  })

  it("provides a bounded action for every non-ready state", () => {
    // Q353 A: a missing CLI gets install guidance, never an installer and
    // nothing to copy that would pass for one.
    const missing = providerFirstRunRecovery({ ...ready, status: "missing" })
    expect(missing).toMatchObject({
      title: "Not installed here",
      description: "Install it with the provider's own instructions so that codex is on the PATH the daemon searches, then press Retry diagnostics.",
    })
    expect(missing.copyGuidance).toBeUndefined()
    // Review P3-9: no Copy sign-in command for a CLI whose command is unknown.
    const unknownCli = providerFirstRunRecovery({ ...ready, id: "aider", command: "aider", status: "auth-required" })
    expect(unknownCli.copyGuidance).toBeUndefined()
    expect(unknownCli.copyLabel).toBeUndefined()
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

  it("shows an approval answered outside Domovoi as an incident to review, not a ready provider", () => {
    expect(providerFirstRunRecovery(ready, failure("approval-answered-elsewhere"))).toEqual({
      kind: "approval-answered-elsewhere",
      title: "An approval was answered outside Domovoi",
      description: "A program on this machine used the provider server's password to answer an approval, so Domovoi stopped that session. What it approved may have run. Review the changes in that session's worktree before you continue it.",
      canComplete: false,
    })
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

  it("renders one card per agent and no permission-mode step", () => {
    const markup = renderToStaticMarkup(
      <FirstRunAgents
        connected
        machine={{ name: "devbox", platform: "linux", version: "0.0.1" }}
        providers={[ready, { ...ready, id: "claude-code", command: "claude" }]}
        sessions={[]}
        refreshing={false}
        recoveryError=""
        onRetry={vi.fn()}
        onCopyGuidance={vi.fn()}
      />,
    )

    expect(markup).toContain("Connect an agent on devbox")
    expect(markup.match(/data-agent-name=/g)).toHaveLength(2)
    expect(markup).toContain("codex")
    expect(markup).toContain("claude-code")
    expect(markup).not.toContain("Choose a permission mode for new projects")
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
    const copy = renderToStaticMarkup(
      <FirstRunAgents
        connected
        machine={{ name: "devbox", platform: "linux", version: "0.0.1" }}
        providers={[ready]}
        sessions={[]}
        refreshing={false}
        recoveryError=""
        onRetry={vi.fn()}
        onCopyGuidance={vi.fn()}
      />,
    )

    expect.soft(copy).toContain("Each agent signs in through its own CLI on this machine")
    expect.soft(copy).not.toMatch(
      /\b(?:nothing leaves|everything (?:stays|remains) (?:on|within)|all (?:data|traffic|requests) (?:stays|remain) (?:on|within)|(?:fully|entirely|completely) local)\b/i,
    )
  })
})
