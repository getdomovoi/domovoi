import type { ProviderRuntime } from "@getdomovoi/protocol"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { workspaceThemeLabel, type WorkspaceTheme } from "./appearance.js"
import {
  desktopExternalActionLabel,
  isDesktopExternalEditor,
  workspaceWindowDecorationLabel,
  type DesktopExternalEditor,
  type WorkspaceWindowDecoration,
} from "./desktop-platform.js"
import { cn } from "./lib/utils"
import { providerDisplayName, providerStatusLabel } from "./runtime.js"

export type ProviderSecretStatus = {
  provider: "anthropic" | "openai" | "openrouter"
  state: "stored" | "not-set" | "unavailable"
  source: "keychain"
}

type ProviderSettingsProps = {
  providers: readonly ProviderRuntime[]
  secrets: readonly ProviderSecretStatus[]
}

export function ProviderSettings({ providers, secrets }: ProviderSettingsProps) {
  return (
    <>
      <h1 className="m-0 text-[17px] font-semibold">Providers on this machine</h1>
      <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
        Subscription CLIs own their credentials. Direct API keys stay in the OS keychain on the machine that runs the agent and never pass through a client or relay.
      </p>

      <section className="mt-6" aria-labelledby="subscription-providers">
        <div className="flex items-center gap-2">
          <h2 id="subscription-providers" className="m-0 text-[9.5px] font-medium tracking-[0.12em] text-faint">SUBSCRIPTION CLIS</h2>
          <Separator className="flex-1" />
        </div>
        <Card className="mt-2.5 gap-0 py-0">
          {providers.map((provider, index) => (
            <div key={provider.id}>
              {index > 0 ? <Separator /> : null}
              <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{providerDisplayName(provider.id)}</span>
                  <span className="truncate font-machine text-[9.5px] text-faint">
                    {provider.command}{provider.version ? ` · ${provider.version}` : ""}
                  </span>
                  <span id={`provider-account-${provider.id}`} className="text-[10px] text-muted-foreground">
                    Run <code className="font-machine">{providerAccountCommand(provider)}</code> in terminal
                  </span>
                </span>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <Badge variant={provider.status === "ready" ? "success" : provider.status === "auth-required" ? "warning" : "outline"}>
                    {providerStatusLabel(provider)}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    data-provider-account-action=""
                    aria-describedby={`provider-account-${provider.id}`}
                    disabled
                  >
                    {providerAccountAction(provider)}
                  </Button>
                </span>
              </div>
            </div>
          ))}
        </Card>
      </section>

      <section className="mt-6" aria-labelledby="direct-api-keys">
        <div className="flex items-center gap-2">
          <h2 id="direct-api-keys" className="m-0 text-[9.5px] font-medium tracking-[0.12em] text-faint">DIRECT API KEYS</h2>
          <Separator className="flex-1" />
        </div>
        <Card className="mt-2.5">
          <CardHeader>
            <CardTitle>OS keychain</CardTitle>
            <CardDescription>Optional credentials for future direct API capabilities. Domovoi never displays, syncs, or logs stored key material.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {secrets.map((secret) => (
              <ProviderKeyRow key={secret.provider} status={secret} />
            ))}
          </CardContent>
        </Card>
      </section>
    </>
  )
}

const themeOptions: readonly {
  value: WorkspaceTheme
  description: string
  preview: { shell: string; panel: string; accent: string }
}[] = [
  {
    value: "system",
    description: "Follows the operating system and changes with it while Domovoi runs.",
    preview: { shell: "#3a3a40", panel: "#d8d8dc", accent: "#7c6cf5" },
  },
  {
    value: "dark",
    description: "Always uses the dark palette.",
    preview: { shell: "#19191b", panel: "#2b2b30", accent: "#9c8cff" },
  },
  {
    value: "light",
    description: "Always uses the light palette.",
    preview: { shell: "#f6f6f8", panel: "#ffffff", accent: "#5945d8" },
  },
]

const windowDecorationOptions: readonly {
  value: WorkspaceWindowDecoration
  description: string
}[] = [
  { value: "domovoi", description: "Domovoi draws the title bar and its own window controls." },
  { value: "system", description: "The operating system draws the window frame and controls." },
]

export function AppearanceSettings({
  theme,
  windowDecoration,
  activeWindowDecoration,
  onThemeChange,
  onWindowDecorationChange,
}: {
  theme: WorkspaceTheme
  onThemeChange: (theme: WorkspaceTheme) => void
} & (
  | {
    windowDecoration: WorkspaceWindowDecoration
    activeWindowDecoration: WorkspaceWindowDecoration
    onWindowDecorationChange: (decoration: WorkspaceWindowDecoration) => void
  }
  | {
    windowDecoration?: undefined
    activeWindowDecoration?: undefined
    onWindowDecorationChange?: undefined
  }
)) {
  const decorationPending = windowDecoration !== undefined
    && activeWindowDecoration !== undefined
    && windowDecoration !== activeWindowDecoration

  return (
    <>
      <h1 className="m-0 text-[17px] font-semibold">Appearance and window</h1>
      <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
        These preferences stay on this client. They are never sent to the execution machine.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Theme</CardTitle>
          <CardDescription>System follows the operating system setting live.</CardDescription>
        </CardHeader>
        <CardContent>
          <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
            {themeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={theme === option.value}
                onClick={() => onThemeChange(option.value)}
                className={cn(
                  "flex min-h-11 flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
                  theme === option.value ? "border-primary bg-accent" : "hover:bg-accent/60",
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex h-12 overflow-hidden rounded-md border"
                  style={{ background: option.preview.shell }}
                >
                  <span className="m-1.5 w-3 rounded-sm" style={{ background: option.preview.accent }} />
                  <span className="my-1.5 mr-1.5 flex-1 rounded-sm" style={{ background: option.preview.panel }} />
                </span>
                <span className="font-medium">{workspaceThemeLabel(option.value)}</span>
                <span className="text-[11px] leading-relaxed text-muted-foreground">
                  {option.description}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {windowDecoration !== undefined && onWindowDecorationChange ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Window decoration</CardTitle>
            <CardDescription>
              Restart Domovoi to apply a decoration change. The running window keeps its current frame.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div role="radiogroup" aria-label="Window decoration" className="grid gap-3 sm:grid-cols-2">
              {windowDecorationOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={windowDecoration === option.value}
                  onClick={() => onWindowDecorationChange(option.value)}
                  className={cn(
                    "flex min-h-11 flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                    windowDecoration === option.value ? "border-primary bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <span className="font-medium">{workspaceWindowDecorationLabel(option.value)}</span>
                  <span className="text-[11px] leading-relaxed text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              ))}
            </div>
            {decorationPending && activeWindowDecoration !== undefined ? (
              <p role="status" className="m-0 text-[11.5px] leading-relaxed text-warning">
                This window still uses the {workspaceWindowDecorationLabel(activeWindowDecoration)} decoration.
                Restart Domovoi to switch to {workspaceWindowDecorationLabel(windowDecoration)}.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </>
  )
}

const externalEditorOptions: readonly { value: DesktopExternalEditor; label: string }[] = [
  { value: "system", label: "System" },
  { value: "vscode", label: "VS Code" },
  { value: "vscode-insiders", label: "VS Code Insiders" },
  { value: "cursor", label: "Cursor" },
  { value: "zed", label: "Zed" },
]

export function ExternalEditorSettings({
  editor,
  onEditorChange,
}: {
  editor: DesktopExternalEditor
  onEditorChange: (editor: DesktopExternalEditor) => void
}) {
  return (
    <>
      <h1 className="m-0 text-[17px] font-semibold">External editor</h1>
      <p className="mt-1.5 max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground">
        Choose the local application Domovoi uses for worktree handoff.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Worktree handoff</CardTitle>
          <CardDescription>The preference stays on this desktop and applies to session-header and command-palette actions.</CardDescription>
        </CardHeader>
        <CardContent>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel id="external-editor-label">Preferred application</FieldLabel>
              <FieldDescription>
                {editor === "system"
                  ? "Uses the operating system file association. Workspace actions say Open externally."
                  : `Workspace actions say ${desktopExternalActionLabel(editor)}.`}
              </FieldDescription>
            </FieldContent>
            <ToggleGroup
              type="single"
              variant="outline"
              value={editor}
              aria-labelledby="external-editor-label"
              className="flex-wrap justify-start"
              onValueChange={(value) => {
                if (isDesktopExternalEditor(value)) onEditorChange(value)
              }}
            >
              {externalEditorOptions.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </CardContent>
      </Card>
    </>
  )
}

function ProviderKeyRow({ status }: { status: ProviderSecretStatus }) {
  const label = directProviderName(status.provider)

  return (
    <Field>
      <div className="flex flex-wrap items-start gap-3">
        <span className="min-w-32 flex-1">
          <FieldLabel>{label}</FieldLabel>
          <FieldDescription>
            {status.state === "stored" ? "Stored" : status.state === "unavailable" ? "Keychain unavailable" : "Not set"}
          </FieldDescription>
        </span>
        <span className="min-w-0 basis-64 flex-[2] text-[10px] leading-relaxed text-muted-foreground">
          Run <code className="font-machine">domovoid secret set {status.provider}</code> locally on the execution machine.
          {status.state === "stored" ? <><br />Delete with <code className="font-machine">domovoid secret delete {status.provider}</code>.</> : null}
        </span>
      </div>
    </Field>
  )
}

export function providerAccountAction(provider: ProviderRuntime): string {
  if (provider.status === "ready") return "Manage"
  if (provider.status === "auth-required") return "Re-authenticate"
  if (provider.status === "missing") return "Install"
  return "Check status"
}

export function providerAccountCommand(provider: ProviderRuntime): string {
  if (provider.id === "claude-code") return "claude auth login"
  if (provider.id === "codex") return "codex login"
  if (provider.id === "cursor-agent") return `${provider.command} login`
  if (provider.id === "grok") return "grok login"
  if (provider.id === "opencode" || provider.id === "kilo") {
    return `${provider.command} auth login`
  }
  return `${provider.command} --help`
}

function directProviderName(provider: ProviderSecretStatus["provider"]): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "openrouter") return "OpenRouter"
  return "Anthropic"
}
