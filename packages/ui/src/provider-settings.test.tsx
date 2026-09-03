import type { ProviderRuntime } from "@getdomovoi/protocol"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import {
  ExternalEditorSettings,
  ProviderSettings,
  providerAccountAction,
  providerAccountCommand,
} from "./provider-settings.js"

const providers: ProviderRuntime[] = [
  {
    id: "claude-code",
    command: "claude",
    status: "ready",
    version: "2.1.247",
    sessionCapable: true,
  },
  {
    id: "codex",
    command: "codex",
    status: "ready",
    version: "0.149.0",
    sessionCapable: true,
  },
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
  {
    id: "opencode",
    command: "opencode",
    status: "ready",
    version: "1.18.23",
    sessionCapable: true,
  },
  {
    id: "kilo",
    command: "kilo",
    status: "missing",
    sessionCapable: true,
  },
]

describe("ProviderSettings", () => {
  it("shows external-editor settings only with an explicit desktop capability", () => {
    const shared = {
      providers,
      secrets: [],
      onBack: vi.fn(),
      onOpenSkills: vi.fn(),
      onOpenAudit: vi.fn(),
      theme: "dark" as const,
      onThemeChange: vi.fn(),
    }
    const webMarkup = renderToStaticMarkup(<ProviderSettings {...shared} />)
    const desktopMarkup = renderToStaticMarkup(
      <ProviderSettings
        {...shared}
        externalEditor="cursor"
        onExternalEditorChange={vi.fn()}
        windowDecoration="domovoi"
        activeWindowDecoration="domovoi"
        onWindowDecorationChange={vi.fn()}
        onResetFirstRun={vi.fn()}
      />,
    )

    expect(webMarkup).toContain("Providers on this machine")
    expect(webMarkup).not.toContain("External editor")
    expect(webMarkup).not.toContain("external-editor-label")
    expect(webMarkup).not.toContain("First-run setup")
    expect(desktopMarkup).toContain(">External editor</button>")
    expect(desktopMarkup).toContain(">First-run setup</button>")
  })

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
        theme="dark"
        onThemeChange={vi.fn()}
        externalEditor="cursor"
        onExternalEditorChange={vi.fn()}
        windowDecoration="domovoi"
        activeWindowDecoration="domovoi"
        onWindowDecorationChange={vi.fn()}
        onResetFirstRun={vi.fn()}
      />,
    )

    expect(markup).toContain("Providers on this machine")
    expect(markup).toContain("Subscription CLIs own their credentials")
    expect(markup).toContain("Cursor Agent")
    expect(markup).toContain("Re-authenticate")
    expect(markup).toContain("claude auth login")
    expect(markup).toContain("codex login")
    expect(markup).toContain("agent login")
    expect(markup).toContain("grok login")
    expect(markup).toContain("opencode auth login")
    expect(markup).toContain("kilo auth login")
    expect(markup.match(/data-provider-account-action=""[^>]*disabled=""/g)).toHaveLength(6)
    expect(markup).toContain("OS keychain")
    expect(markup).toContain("OpenRouter")
    expect(markup).toContain("Keychain unavailable")
    expect(markup).toContain("domovoid secret set openai")
    expect(markup).toContain("domovoid secret delete anthropic")
    expect(markup).not.toContain('type="password"')
    expect(markup).not.toMatch(/>Store<\/button|>Replace<\/button|>Remove<\/button/)
    expect(markup).not.toMatch(/sk-|secret@example|key ending/i)
    expect(markup).toContain(">External editor</button>")
  })

  it("uses the installed single-choice primitive for every allowlisted editor", () => {
    const markup = renderToStaticMarkup(
      <ExternalEditorSettings editor="cursor" onEditorChange={vi.fn()} />,
    )
    const systemMarkup = renderToStaticMarkup(
      <ExternalEditorSettings editor="system" onEditorChange={vi.fn()} />,
    )

    expect(markup).toContain("External editor")
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain('data-state="on"')
    expect(markup).toContain(">System</button>")
    expect(markup).toContain(">VS Code</button>")
    expect(markup).toContain(">Cursor</button>")
    expect(markup).toContain(">Zed</button>")
    expect(systemMarkup).toContain("Open externally")
    expect(systemMarkup).not.toContain("Open in editor")
    expect(markup).not.toMatch(/token|secret|password/i)
  })

  it("returns clear account actions for each readiness state", () => {
    expect(providerAccountAction(providers[0]!)).toBe("Manage")
    expect(providerAccountAction(providers.find((provider) => provider.id === "grok")!)).toBe("Re-authenticate")
    expect(providerAccountAction({ ...providers[0]!, status: "missing" })).toBe("Install")
    expect(providerAccountAction({ ...providers[0]!, status: "unknown" })).toBe("Check status")
    expect(providers.map(providerAccountCommand)).toEqual([
      "claude auth login",
      "codex login",
      "agent login",
      "grok login",
      "opencode auth login",
      "kilo auth login",
    ])
  })
})
