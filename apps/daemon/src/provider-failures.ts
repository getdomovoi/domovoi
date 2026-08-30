import { providerFailureSchema, type ProviderFailure } from "@getdomovoi/protocol"

export type ProviderFailureKind = ProviderFailure["kind"]
export type ProviderFailureAction = ProviderFailure["action"]

export function classifyProviderFailure(error: unknown): ProviderFailure {
  const detail = error instanceof Error ? error.message : ""
  if (/\b401\b|unauthenticated|not logged|login required|token expired|authentication expired/i.test(detail)) {
    return failure("authentication-expired", "sign-in", "Provider authentication expired", false)
  }
  if (/insufficient[_ -]?quota|quota exhausted|billing quota/i.test(detail)) {
    return failure("quota-exhausted", "check-quota", "Provider quota is exhausted", false)
  }
  if (/\b429\b|rate limit|too many requests/i.test(detail)) {
    return failure("rate-limit", "retry", "Provider rate limit reached", true)
  }
  if (/model.+(?:not found|unavailable|unsupported)|unknown model/i.test(detail)) {
    return failure("model-unavailable", "change-model", "Selected model is unavailable", false)
  }
  if (/ECONN|EPIPE|socket|connection (?:closed|reset)|transport/i.test(detail)) {
    return failure("transport", "retry", "Provider connection failed", true)
  }
  return failure("unknown", "retry", "Provider request failed", true)
}

export function providerTurnCompletion(params: Record<string, unknown>): {
  failed: boolean
  failure?: ProviderFailure
} {
  const turn = params.turn && typeof params.turn === "object"
    ? params.turn as Record<string, unknown>
    : undefined
  const status = typeof params.status === "string" ? params.status : turn?.status
  if (status !== "failed") return { failed: false }

  const explicit = providerFailureSchema.safeParse(params.failure)
  if (explicit.success) return { failed: true, failure: explicit.data }
  const turnError = turn?.error && typeof turn.error === "object"
    ? turn.error as Record<string, unknown>
    : undefined
  const reason = typeof params.reason === "string"
    ? params.reason
    : typeof turn?.error === "string"
      ? turn.error
      : typeof turnError?.message === "string"
        ? turnError.message
      : ""
  return { failed: true, failure: classifyProviderFailure(new Error(reason)) }
}

function failure(
  kind: ProviderFailureKind,
  action: ProviderFailureAction,
  message: string,
  retryable: boolean,
): ProviderFailure {
  return providerFailureSchema.parse({ kind, action, message, retryable })
}
