import type { ProviderModel, ProviderRuntime, Runtime } from "@getdomovoi/protocol"

const fallbackReasoningOptions = ["low", "medium", "high"] as const

const providerNames: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "cursor-agent": "Cursor Agent",
  opencode: "OpenCode",
  grok: "Grok CLI",
  kilo: "Kilo Code",
}

export function reasoningOptionsFor(model?: ProviderModel): readonly string[] {
  return model ? model.supportedReasoningEfforts : fallbackReasoningOptions
}

export function selectRuntimeModel(runtime: Runtime, model: ProviderModel): Runtime {
  return {
    ...runtime,
    provider: model.provider,
    model: model.id,
    reasoning: model.supportedReasoningEfforts.includes(runtime.reasoning)
      ? runtime.reasoning
      : model.defaultReasoningEffort,
  }
}

export function requiresProviderHandoff(runtime: Runtime, model: ProviderModel): boolean {
  return runtime.provider !== model.provider
}

export function providerHandoffDescription(provider: string, model: string): string {
  return `Domovoi checkpoints this worktree and carries the thread, plan, diff, test results, and open annotations to ${provider} / ${model}. Hidden reasoning, provider caches, and private session metadata do not transfer.`
}

export function providerCanStartSession(provider: ProviderRuntime): boolean {
  return provider.sessionCapable
    && provider.status !== "auth-required"
    && provider.status !== "missing"
}

export function providerStatusLabel(provider: ProviderRuntime): string {
  if (provider.status === "auth-required") return "Sign in required"
  if (provider.status === "missing") return "Not installed"
  if (provider.status === "unknown") return "Detected"
  return "Ready"
}

export function providerDisplayName(providerId: string): string {
  return providerNames[providerId] ?? providerId
}

export function preferredSessionProvider(
  providers: readonly ProviderRuntime[],
): ProviderRuntime | undefined {
  const available = providers.filter(providerCanStartSession)
  return available.find((provider) => provider.id === "codex") ?? available[0]
}
