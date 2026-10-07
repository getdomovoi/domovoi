import type { ProviderModel, ProviderRuntime, Runtime } from "@getdomovoi/protocol"

import { effortLevel, effortRank } from "./effort-scales.js"

const providerNames: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "cursor-agent": "Cursor Agent",
  opencode: "OpenCode",
  grok: "Grok CLI",
  kilo: "Kilo Code",
}

// `from` is the provider whose scale `runtime.reasoning` was chosen on. It is
// the runtime's own provider except where a caller names the new provider
// before its models arrive, as the launcher does.
export function selectRuntimeModel(runtime: Runtime, model: ProviderModel, from: string = runtime.provider): Runtime {
  return {
    ...runtime,
    provider: model.provider,
    model: model.id,
    reasoning: carriedEffort(runtime.reasoning, from, model),
  }
}

// Desktop V2's effort on a model change. The level stays when the new model
// reports it, read by its shared word rather than the raw value. A raw id is kept first only on the
// same provider: across providers the same id can name another level or none,
// so the shared word decides before it. Otherwise it moves to the new model's
// default, and only a model that names no default among its levels gets the
// nearest level it reports. The daemon refuses a level the model does not
// report, so a model that reports none keeps its default, the one value the
// daemon accepts for it.
function carriedEffort(reasoning: string, from: string, model: ProviderModel): string {
  const levels = model.supportedReasoningEfforts
  if (from === model.provider && levels.includes(reasoning)) return reasoning
  const word = effortLevel(from, reasoning).label
  const same = word === undefined ? undefined : levels.find((id) => effortLevel(model.provider, id).label === word)
  if (same !== undefined) return same
  if (levels.includes(reasoning)) return reasoning
  if (levels.length === 0 || levels.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort
  return nearestEffort(word, model.provider, levels) ?? levels[0] ?? model.defaultReasoningEffort
}

// The reported level whose shared word is closest in rank, the lower one on
// a tie. Undefined when the level or every reported level has no ranked
// word; the caller then takes the first level the model reports.
function nearestEffort(word: string | undefined, provider: string, levels: readonly string[]): string | undefined {
  const rank = word === undefined ? -1 : effortRank.indexOf(word)
  if (rank < 0) return undefined
  let nearest: { id: string, distance: number, rank: number } | undefined
  for (const id of levels) {
    const label = effortLevel(provider, id).label
    const candidate = label === undefined ? -1 : effortRank.indexOf(label)
    if (candidate < 0) continue
    const distance = Math.abs(candidate - rank)
    if (!nearest || distance < nearest.distance || (distance === nearest.distance && candidate < nearest.rank)) {
      nearest = { id, distance, rank: candidate }
    }
  }
  return nearest?.id
}

export function requiresProviderHandoff(runtime: Runtime, model: ProviderModel): boolean {
  return runtime.provider !== model.provider
}

export function providerHandoffDescription(provider: string, model: string): string {
  return `Domovoi checkpoints this worktree and carries the thread, plan, diff, test results, and open annotations to ${provider} / ${model}. Hidden reasoning, provider caches, and private session metadata do not transfer.`
}

export function providerCanStartSession(provider: ProviderRuntime): boolean {
  return provider.sessionCapable
    && provider.problem === undefined
    && provider.status !== "auth-required"
    && provider.status !== "missing"
}

export function providerStatusLabel(provider: ProviderRuntime): string {
  if (provider.problem !== undefined) return "Cannot start"
  if (provider.status === "auth-required") return "Sign in required"
  // A miss on the searched PATH, not a fact about the machine.
  if (provider.status === "missing") return "Not found"
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
