import { useId, useState } from "react"
import type { ProviderRuntime } from "@getdomovoi/protocol"

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

export type ProviderSecretStatus = {
  provider: "anthropic" | "openai" | "openrouter"
  state: "stored" | "not-set" | "unavailable"
  source: "keychain"
}

type ProviderSettingsProps = {
  // This machine's providers, listed when `machines` is not given.
  providers: readonly ProviderRuntime[]
  // Every machine's agents as this client knows them (fleetAgents).
  machines?: readonly MachineAgents[] | undefined
  secrets: readonly ProviderSecretStatus[]
  localDaemon?: { title: string; detail: string }
  // Q336 A: names a command as it runs on the execution machine, when that
  // is this one; otherwise commands print as written.
  printCommand?: ((command: string) => string) | undefined
}

export function ProviderSettings({ providers, machines, secrets, localDaemon, printCommand }: ProviderSettingsProps) {
  const rows = machines ?? [{ machineId: "this-machine", label: "this machine", providers }]
  return (
    <>
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b px-[15px] py-[13px]">
          <h2 className="m-0 text-[13px] font-medium">Providers and tokens</h2>
          {/* Q18 A, 2026-10-06: the rows span machines, and M1 has no Domovoi account (Q5). */}
          <p className="m-0 max-w-[68ch] text-[11.5px] leading-relaxed text-muted-foreground">
            Stored on each machine that runs the agent. Domovoi does not send it to another device. Subscription CLIs own their credentials.
          </p>
        </div>
        <MachineAgentList machines={rows} />
      </div>

      {localDaemon ? (
        <section className="mt-6" aria-labelledby="local-daemon">
          <div className="flex items-center gap-2">
            <h2 id="local-daemon" className="m-0 text-[9.5px] font-medium tracking-[0.12em] text-faint">LOCAL DAEMON</h2>
            <Separator className="flex-1" />
          </div>
          <Card className="mt-2.5">
            <CardHeader>
              <CardTitle>{localDaemon.title}</CardTitle>
              <CardDescription>{localDaemon.detail}</CardDescription>
            </CardHeader>
          </Card>
        </section>
      ) : null}

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
              <ProviderKeyRow key={secret.provider} status={secret} print={printCommand ?? ((command) => command)} />
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
    description: "Follows your OS appearance, including scheduled switches.",
    preview: { shell: "#3a3a40", panel: "#d8d8dc", accent: "#7c6cf5" },
  },
  {
    value: "dark",
    description: "The default. Tuned for long sessions and terminal output.",
    preview: { shell: "#19191b", panel: "#2b2b30", accent: "#9c8cff" },
  },
  {
    value: "light",
    description: "The same tokens inverted. Diffs read on paper-white.",
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
      <h2 className="m-0 text-[13px] font-medium">Appearance</h2>
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

function ProviderKeyRow({ status, print }: { status: ProviderSecretStatus; print: (command: string) => string }) {
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
        <span className="min-w-0 basis-64 flex-[2] text-micro leading-relaxed text-muted-foreground">
          Run <code className="font-machine">{print(`domovoid secret set ${status.provider}`)}</code> locally on the execution machine.
          {status.state === "stored" ? <><br />Delete with <code className="font-machine">{print(`domovoid secret delete ${status.provider}`)}</code>.</> : null}
        </span>
      </div>
    </Field>
  )
}

// One machine's agents as this client knows them. Without providers the
// machine was never read here, and `unknown` says why instead of a guess.
export type MachineAgents = {
  machineId: string
  label: string
  providers?: readonly ProviderRuntime[] | undefined
  unknown?: string | undefined
  // Set when the providers come from an earlier reading: "as of 14:03".
  stale?: string | undefined
}

type AgentTone = "success" | "warning" | "destructive" | "muted" | "faint"

const agentDot: Record<AgentTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
  faint: "bg-faint",
}

function agentState(provider: ProviderRuntime): { state: string; tone: AgentTone } {
  if (provider.problem !== undefined) return { state: "cannot start", tone: "destructive" }
  if (provider.status === "auth-required") return { state: "needs sign-in on that machine", tone: "warning" }
  if (provider.status === "unknown") return { state: "found, sign-in not checked", tone: "muted" }
  return { state: "ready", tone: "success" }
}

// A provider the daemon looked for and did not find is not installed there,
// and the list says what is installed per machine.
function installedProviders(providers: readonly ProviderRuntime[]): ProviderRuntime[] {
  return providers.filter((provider) => provider.status !== "missing")
}

// The design's Agents and providers rows, one per machine and agent: a dot,
// the agent, the machine, its state, and an action only where one is needed.
// Signing in happens in that machine's own terminal, so Authenticate there says
// what to run where; Domovoi never holds or forwards the provider's credential.
export function MachineAgentList({ machines }: { machines: readonly MachineAgents[] }) {
  return (
    <ul className="m-0 list-none p-0">
      {machines.flatMap((machine) => {
        if (!machine.providers) {
          return [<AgentRow key={machine.machineId} name="unknown" machine={machine.label} state={machine.unknown ?? "not read yet"} tone="faint" dimmed />]
        }
        const installed = installedProviders(machine.providers)
        if (installed.length === 0) {
          return [<AgentRow key={machine.machineId} name="none found" machine={machine.label}
            state={machine.stale ? `no agent on its PATH · ${machine.stale}` : "no agent on its PATH"} tone="faint" dimmed={machine.stale !== undefined} />]
        }
        return installed.map((provider) => {
          const { state, tone } = agentState(provider)
          return (
            <AgentRow
              key={`${machine.machineId}:${provider.id}`}
              name={provider.id}
              machine={machine.label}
              state={machine.stale ? `${state} · ${machine.stale}` : state}
              tone={machine.stale ? "faint" : tone}
              dimmed={machine.stale !== undefined}
              problem={provider.problem}
              signIn={provider.status === "auth-required" && provider.problem === undefined && !machine.stale ? provider : undefined}
            />
          )
        })
      })}
    </ul>
  )
}

function AgentRow({ name, machine, state, tone, dimmed = false, problem, signIn }: {
  name: string
  machine: string
  state: string
  tone: AgentTone
  dimmed?: boolean
  problem?: string | undefined
  signIn?: ProviderRuntime | undefined
}) {
  const [open, setOpen] = useState(false)
  const noteId = useId()
  const command = signIn ? providerAccountCommand(signIn) : undefined
  return (
    <li className={cn("border-t px-[15px] py-2.5 first:border-t-0", dimmed && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-x-[11px] gap-y-1">
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", agentDot[tone])} />
        <span data-agent-cell="" className="w-[150px] shrink-0 truncate font-machine text-[11.5px] text-strong sm:w-[190px]">{name}</span>
        <span data-agent-cell="" className="w-[120px] shrink-0 truncate font-machine text-micro text-muted-foreground sm:w-[150px]">{machine}</span>
        <span data-agent-cell="" className="min-w-0 text-[11.5px] text-muted-foreground">{state}</span>
        <span className="flex-1" />
        {signIn ? (
          <Button
            type="button"
            // The link variant carries no fill of its own, so the info pill
            // keeps its colours in every state, aria-expanded included.
            variant="link"
            aria-expanded={open}
            aria-controls={noteId}
            aria-label={`Authenticate there: ${name} on ${machine}`}
            onClick={() => setOpen(!open)}
            className="h-auto rounded-full border-info-border bg-info-background px-2.5 py-[5px] text-[11px] font-normal text-info-foreground hover:no-underline"
          >
            Authenticate there
          </Button>
        ) : null}
      </div>
      {problem ? <p className="m-0 mt-1 pl-[17px] text-micro leading-relaxed text-muted-foreground">{problem}</p> : null}
      {signIn ? (
        <p id={noteId} hidden={!open} className="m-0 mt-1.5 pl-[17px] text-[11.5px] leading-relaxed text-info-foreground">
          {command
            ? <>Run <code className="font-machine">{command}</code> in a terminal on {machine}.</>
            : <>Sign in with <code className="font-machine">{signIn.command}</code>&apos;s own instructions in a terminal on {machine}.</>}
          {" "}Domovoi does not sign in for you.
        </p>
      ) : null}
    </li>
  )
}

// The provider CLI's own sign-in command. Undefined for a provider whose
// command Domovoi does not know (review P3-9): a help command is not one.
export function providerAccountCommand(provider: ProviderRuntime): string | undefined {
  if (provider.id === "claude-code") return "claude auth login"
  if (provider.id === "codex") return "codex login"
  if (provider.id === "cursor-agent") return `${provider.command} login`
  if (provider.id === "grok") return "grok login"
  if (provider.id === "opencode" || provider.id === "kilo") {
    return `${provider.command} auth login`
  }
  return undefined
}

function directProviderName(provider: ProviderSecretStatus["provider"]): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "openrouter") return "OpenRouter"
  return "Anthropic"
}
