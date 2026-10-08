import type { ProviderRuntime } from "@getdomovoi/protocol"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import {
  ExternalEditorSettings,
  ProviderSettings,
  providerAccountCommand,
} from "./provider-settings.js"
import { defaultNotificationPreferences } from "./notification-preferences.js"
import { SettingsShell } from "./settings-shell.js"

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

describe("Settings shell and provider pane", () => {
  it("shows external-editor settings only with an explicit desktop capability", () => {
    const shared = {
      providers,
      secrets: [],
      approvalRules: [],
      notifications: defaultNotificationPreferences(),
      onNotificationsChange: vi.fn(),
      onOpenFleet: vi.fn(),
      onOpenSkills: vi.fn(),
      onOpenAudit: vi.fn(),
      theme: "dark" as const,
      onThemeChange: vi.fn(),
    }
    const webMarkup = renderToStaticMarkup(<SettingsShell {...shared} />)
    const desktopMarkup = renderToStaticMarkup(
      <SettingsShell
        {...shared}
        externalEditor="cursor"
        onExternalEditorChange={vi.fn()}
        windowDecoration="domovoi"
        activeWindowDecoration="domovoi"
        onWindowDecorationChange={vi.fn()}
        onResetFirstRun={vi.fn()}
      />,
    )

    expect(webMarkup).toContain("Providers and tokens")
    expect(webMarkup).not.toContain("External editor")
    expect(webMarkup).not.toContain("external-editor-label")
    expect(webMarkup).not.toContain("First-run setup")
    expect(desktopMarkup).toContain(">External editor</h1>")
    expect(desktopMarkup).toContain(">First-run setup</button>")
  })

  it("renders signed-handoff provider readiness and keychain status", () => {
    const markup = renderToStaticMarkup(
      <SettingsShell
        providers={providers}
        secrets={[
          { provider: "anthropic", state: "stored", source: "keychain" },
          { provider: "openai", state: "not-set", source: "keychain" },
          { provider: "openrouter", state: "unavailable", source: "keychain" },
        ]}
        approvalRules={[]}
        notifications={defaultNotificationPreferences()}
        onNotificationsChange={vi.fn()}
        onOpenFleet={vi.fn()}
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

    expect(markup).toContain("Providers and tokens")
    expect(markup).toContain("Subscription CLIs own their credentials")
    expect(markup).not.toContain("SUBSCRIPTION CLIS")
    for (const id of ["claude-code", "codex", "cursor-agent", "grok", "opencode"]) expect(markup).toContain(`>${id}</span>`)
    // Kilo was looked for and not found, so it is not installed there.
    expect(markup).not.toContain(">kilo</span>")
    // One action, where one is needed: Grok needs sign-in, and the command is named for it.
    expect(markup.match(/>Authenticate there</g)).toHaveLength(1)
    // A standard control, so it is the shared Button primitive (AGENTS.md).
    expect(markup).toMatch(/<button data-slot="button"[^>]*>Authenticate there</)
    expect(markup).toContain("grok login")
    expect(markup).not.toContain("data-provider-account-action")
    expect(markup).toContain("OS keychain")
    expect(markup).toContain("OpenRouter")
    expect(markup).toContain("Keychain unavailable")
    expect(markup).toContain("domovoid secret set openai")
    expect(markup).toContain("domovoid secret delete anthropic")
    expect(markup).not.toContain('type="password"')
    expect(markup).not.toMatch(/>Store<\/button|>Replace<\/button|>Remove<\/button/)
    expect(markup).not.toMatch(/sk-|secret@example|key ending/i)
    expect(markup).toContain(">External editor</h1>")
  })

  it("says provider credentials stay on each machine without claiming an account or relay", () => {
    const markup = renderToStaticMarkup(<ProviderSettings providers={providers} secrets={[]} />)

    // Q18 A (standing ruling 2026-10-06): the rows span machines, so the line names each one.
    expect(markup).toContain("Stored on each machine that runs the agent. Domovoi does not send it to another device.")
    expect(markup).toContain("Subscription CLIs own their credentials.")
    expect(markup).not.toMatch(/Domovoi account|relay/i)
  })

  it("lists each machine's agents across the fleet and says which machines are unknown", () => {
    const markup = renderToStaticMarkup(
      <ProviderSettings
        providers={providers}
        secrets={[]}
        machines={[
          { machineId: "m1", label: "workshop", providers: [providers[0]!, { ...providers[1]!, status: "auth-required" }] },
          { machineId: "m2", label: "studio", unknown: "this app holds no client credential for it" },
          { machineId: "m3", label: "lab", providers: [providers[0]!], stale: "as of 14:03" },
        ]}
      />,
    )
    const rows = [...markup.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map(([, row]) =>
      [...row!.matchAll(/data-agent-cell=""[^>]*>([^<]*)</g)].map(([, cell]) => cell))

    expect(rows).toEqual([
      ["claude-code", "workshop", "ready"],
      ["codex", "workshop", "needs sign-in on that machine"],
      ["unknown", "studio", "this app holds no client credential for it"],
      ["claude-code", "lab", "ready · as of 14:03"],
    ])
    expect(markup).toContain("codex login")
    expect(markup).not.toContain(">grok</span>")
  })

  it("hands the fleet's agents to the providers pane", () => {
    const markup = renderToStaticMarkup(
      <SettingsShell
        providers={providers}
        providerMachines={[{ machineId: "m2", label: "studio", unknown: "this app holds no client credential for it" }]}
        secrets={[]}
        approvalRules={[]}
        notifications={defaultNotificationPreferences()}
        onNotificationsChange={vi.fn()}
        onOpenFleet={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenAudit={vi.fn()}
        theme="dark"
        onThemeChange={vi.fn()}
      />,
    )

    expect(markup).toContain(">studio</span>")
    expect(markup).toContain("this app holds no client credential for it")
    expect(markup).not.toContain(">claude-code</span>")
  })

  it("shows why a detected provider cannot start sessions instead of the sign-in hint", () => {
    const problem = "Update Claude Code to 2.1.263 or newer. The claude on this machine is 2.1.100."
    const markup = renderToStaticMarkup(
      <SettingsShell
        providers={[{ ...providers[0]!, version: "2.1.100", problem }]}
        secrets={[]}
        approvalRules={[]}
        notifications={defaultNotificationPreferences()}
        onNotificationsChange={vi.fn()}
        onOpenFleet={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenAudit={vi.fn()}
        theme="dark"
        onThemeChange={vi.fn()}
      />,
    )

    expect(markup).toContain(problem)
    expect(markup).toContain("cannot start")
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

  it("names each provider's own sign-in command", () => {
    expect(providers.map(providerAccountCommand)).toEqual([
      "claude auth login",
      "codex login",
      "agent login",
      "grok login",
      "opencode auth login",
      "kilo auth login",
    ])
    // Review P3-9: a provider whose sign-in command Domovoi does not know
    // gets none, rather than a help command labelled as one.
    expect(providerAccountCommand({ ...providers[0]!, id: "aider", command: "aider" })).toBeUndefined()
  })
})
