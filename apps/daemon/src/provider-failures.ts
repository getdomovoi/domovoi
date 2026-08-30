export type ProviderFailureKind =
  | "authentication-expired"
  | "rate-limit"
  | "quota-exhausted"
  | "model-unavailable"
  | "transport"
  | "unknown"

export type ProviderFailureAction = "sign-in" | "retry" | "check-quota" | "change-model"

export type ProviderFailure = {
  kind: ProviderFailureKind
  action: ProviderFailureAction
  message: string
  retryable: boolean
}

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

function failure(
  kind: ProviderFailureKind,
  action: ProviderFailureAction,
  message: string,
  retryable: boolean,
): ProviderFailure {
  return { kind, action, message, retryable }
}
