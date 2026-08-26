import type { ProviderModel, Runtime } from "@getdomovoi/protocol"

const fallbackReasoningOptions = ["low", "medium", "high"] as const

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
