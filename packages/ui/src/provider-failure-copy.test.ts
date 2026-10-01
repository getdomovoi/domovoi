import type { ProviderFailure } from "@getdomovoi/protocol"
import { expect, it } from "vitest"

import { providerFailureActionCopy } from "./workspace-shell.js"

it("tells a person to shorten the turn when it outgrew the context window", () => {
  const failure: ProviderFailure = {
    kind: "context-window-exceeded",
    action: "shorten-context",
    message: "Turn exceeded the model context window",
    retryable: false,
  }

  expect(providerFailureActionCopy(failure)).toMatch(/shorten|checkpoint|new session/iu)
})

it("tells a person to review the changes when an approval was answered outside Domovoi", () => {
  const failure: ProviderFailure = {
    kind: "approval-answered-elsewhere",
    action: "review-changes",
    message: "An approval was answered outside Domovoi",
    retryable: false,
  }

  const copy = providerFailureActionCopy(failure)
  expect(copy).toMatch(/review/iu)
  expect(copy).toMatch(/may have run/iu)
  expect(copy).not.toMatch(/[—!]/u)
})

it("never tells a person to retry a failure the provider marked permanent", () => {
  const permanent: ProviderFailure[] = [
    { kind: "context-window-exceeded", action: "shorten-context", message: "Turn exceeded the model context window", retryable: false },
    { kind: "quota-exhausted", action: "check-quota", message: "Provider quota is exhausted", retryable: false },
    { kind: "model-unavailable", action: "change-model", message: "Selected model is unavailable", retryable: false },
    { kind: "approval-answered-elsewhere", action: "review-changes", message: "An approval was answered outside Domovoi", retryable: false },
  ]

  for (const failure of permanent) {
    expect(providerFailureActionCopy(failure)).not.toMatch(/^Retry/u)
  }
})
