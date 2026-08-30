import type { ProviderRuntime } from "@getdomovoi/protocol"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ProviderSettings, providerAccountAction } from "./provider-settings.js"

const providers: ProviderRuntime[] = [
  {
    id: "cursor-agent",
    command: "agent",
    status: "ready",
    version: "2026.08.1",
    sessionCapable: true,
  },
  {
    id: "grok",
    command: "grok",
    status: "auth-required",
    version: "0.18.0",
    sessionCapable: true,
  },
]

describe("ProviderSettings", () => {
  it("renders signed-handoff provider readiness and keychain status", () => {
    const markup = renderToStaticMarkup(
      <ProviderSettings
        providers={providers}
        secrets={[
          { provider: "anthropic", state: "stored", source: "keychain" },
          { provider: "openai", state: "not-set", source: "keychain" },
          { provider: "openrouter", state: "unavailable", source: "keychain" },
        ]}
        onBack={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenAudit={vi.fn()}
        onSetSecret={vi.fn()}
        onDeleteSecret={vi.fn()}
      />,
    )

    expect(markup).toContain("Providers on this machine")
    expect(markup).toContain("Subscription CLIs own their credentials")
    expect(markup).toContain("Cursor Agent")
    expect(markup).toContain("Re-authenticate")
    expect(markup).toContain("OS keychain")
    expect(markup).toContain("OpenRouter")
    expect(markup).toContain("Keychain unavailable")
    expect(markup).not.toMatch(/sk-|secret@example|key ending/i)
  })

  it("returns clear account actions for each readiness state", () => {
    expect(providerAccountAction(providers[0]!)).toBe("Manage")
    expect(providerAccountAction(providers[1]!)).toBe("Re-authenticate")
    expect(providerAccountAction({ ...providers[0]!, status: "missing" })).toBe("Install")
    expect(providerAccountAction({ ...providers[0]!, status: "unknown" })).toBe("Check status")
  })
})
