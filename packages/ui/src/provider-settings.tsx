import { useState } from "react"
import type { ProviderRuntime } from "@getdomovoi/protocol"
import { ArrowLeftIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
  onSetSecret,
  onDeleteSecret,
}: {
  providers: readonly ProviderRuntime[]
  secrets: readonly ProviderSecretStatus[]
  onBack: () => void
  onOpenSkills: () => void
  onOpenAudit: () => void
  onSetSecret: (provider: ProviderSecretStatus["provider"], secret: string) => Promise<void> | void
  onDeleteSecret: (provider: ProviderSecretStatus["provider"]) => Promise<void> | void
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
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant={provider.status === "ready" ? "success" : provider.status === "auth-required" ? "warning" : "outline"}>
                        {providerStatusLabel(provider)}
                      </Badge>
                      <Button variant="outline" size="sm">{providerAccountAction(provider)}</Button>
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
                  <ProviderKeyRow
                    key={secret.provider}
                    status={secret}
                    onSet={onSetSecret}
                    onDelete={onDeleteSecret}
                  />
                ))}
              </CardContent>
            </Card>
          </section>
        </main>
      </ScrollArea>
    </div>
  )
}

function ProviderKeyRow({
  status,
  onSet,
  onDelete,
}: {
  status: ProviderSecretStatus
  onSet: (provider: ProviderSecretStatus["provider"], secret: string) => Promise<void> | void
  onDelete: (provider: ProviderSecretStatus["provider"]) => Promise<void> | void
}) {
  const [value, setValue] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const label = directProviderName(status.provider)

  const save = async () => {
    if (!value.trim() || pending || status.state === "unavailable") return
    setPending(true)
    setError("")
    try {
      await onSet(status.provider, value)
      setValue("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Key could not be stored")
    } finally {
      setPending(false)
    }
  }

  return (
    <Field>
      <div className="flex flex-wrap items-end gap-2">
        <span className="min-w-32 flex-1">
          <FieldLabel htmlFor={`provider-key-${status.provider}`}>{label}</FieldLabel>
          <FieldDescription>
            {status.state === "stored" ? "Stored" : status.state === "unavailable" ? "Keychain unavailable" : "Not set"}
          </FieldDescription>
        </span>
        <Input
          id={`provider-key-${status.provider}`}
          type="password"
          autoComplete="off"
          aria-label={`${label} API key`}
          className="min-w-48 flex-[2]"
          disabled={status.state === "unavailable" || pending}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button variant="outline" size="sm" disabled={!value.trim() || pending || status.state === "unavailable"} onClick={() => void save()}>
          {pending ? "Saving…" : status.state === "stored" ? "Replace" : "Store"}
        </Button>
        {status.state === "stored" ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void onDelete(status.provider)}>Remove</Button>
        ) : null}
      </div>
      {error ? <FieldDescription className="text-destructive">{error}</FieldDescription> : null}
    </Field>
  )
}

export function providerAccountAction(provider: ProviderRuntime): string {
  if (provider.status === "ready") return "Manage"
  if (provider.status === "auth-required") return "Re-authenticate"
  if (provider.status === "missing") return "Install"
  return "Check status"
}

function directProviderName(provider: ProviderSecretStatus["provider"]): string {
  if (provider === "openai") return "OpenAI"
  if (provider === "openrouter") return "OpenRouter"
  return "Anthropic"
}
