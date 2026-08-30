import type { ProviderRuntime } from "@getdomovoi/protocol"
import { ArrowLeftIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { providerDisplayName, providerStatusLabel } from "./runtime.js"

export type ProviderSecretStatus = {
  provider: "anthropic" | "openai" | "openrouter"
  state: "stored" | "not-set" | "unavailable"
  source: "keychain"
}

export function ProviderSettings({
  providers,
  secrets,
  onBack,
  onOpenSkills,
  onOpenAudit,
}: {
  providers: readonly ProviderRuntime[]
  secrets: readonly ProviderSecretStatus[]
  onBack: () => void
  onOpenSkills: () => void
  onOpenAudit: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-[236px] shrink-0 flex-col border-r bg-sidebar p-2.5 sm:flex">
        <Button variant="ghost" className="mb-2 justify-start" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          Workspace
        </Button>
        <div className="px-2 py-2 text-base font-semibold">Settings</div>
        <Button variant="secondary" className="justify-start">Providers</Button>
        <Button variant="ghost" className="justify-start" onClick={onOpenSkills}>Skills</Button>
        <Button variant="ghost" className="justify-start" onClick={onOpenAudit}>Audit log</Button>
      </aside>

      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <main className="mx-auto w-full max-w-[780px] px-4 py-5 sm:px-8 sm:py-7">
          <div className="mb-3 -ml-2 flex items-center gap-1 sm:hidden">
            <Button variant="ghost" className="min-h-11" onClick={onBack}>
              <ArrowLeftIcon data-icon="inline-start" />
              Workspace
            </Button>
            <Button variant="ghost" className="min-h-11" onClick={onOpenSkills}>Skills</Button>
            <Button variant="ghost" className="min-h-11" onClick={onOpenAudit}>Audit log</Button>
          </div>

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
                  <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{providerDisplayName(provider.id)}</span>
                      <span className="truncate font-machine text-[9.5px] text-faint">
                        {provider.command}{provider.version ? ` · ${provider.version}` : ""}
                      </span>
                      <span id={`provider-account-${provider.id}`} className="text-[10px] text-muted-foreground">
                        Run <code className="font-machine">{providerAccountCommand(provider)}</code> in terminal
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
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
        </main>
      </ScrollArea>
    </div>
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
        <span className="min-w-64 flex-[2] text-[10px] leading-relaxed text-muted-foreground">
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
