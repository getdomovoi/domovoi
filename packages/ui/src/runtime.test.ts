import { describe, expect, it } from "vitest"

import type { ProviderModel, ProviderRuntime, Runtime } from "@getdomovoi/protocol"

import {
  preferredSessionProvider,
  providerCanStartSession,
  providerStatusLabel,
  reasoningOptionsFor,
  selectRuntimeModel,
} from "./runtime"

const runtime: Runtime = {
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoning: "high",
  permissionMode: "build",
  auto: false,
}

const model = (supportedReasoningEfforts: ProviderModel["supportedReasoningEfforts"]): ProviderModel => ({
  provider: "codex",
  id: "gpt-5.6-luna",
  displayName: "GPT-5.6 Luna",
  description: "Fast coding model",
  supportedReasoningEfforts,
  defaultReasoningEffort: "medium",
  isDefault: false,
})

describe("selectRuntimeModel", () => {
  it("preserves a supported reasoning level", () => {
    expect(selectRuntimeModel(runtime, model(["medium", "high"]))).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: "high",
    })
  })

  it("uses the model default when the current reasoning level is unsupported", () => {
    expect(selectRuntimeModel(runtime, model(["low", "medium"]))).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: "medium",
    })
  })

  it("preserves an explicit empty reasoning catalog", () => {
    expect(reasoningOptionsFor(model([]))).toEqual([])
    expect(reasoningOptionsFor()).toEqual(["low", "medium", "high"])
  })
})

const provider = (overrides: Partial<ProviderRuntime>): ProviderRuntime => ({
  id: "codex",
  command: "codex",
  status: "ready",
  sessionCapable: true,
  ...overrides,
})

describe("provider readiness", () => {
  it("only enables detected providers backed by an agent adapter", () => {
    expect(providerCanStartSession(provider({ status: "ready" }))).toBe(true)
    expect(providerCanStartSession(provider({ status: "unknown" }))).toBe(true)
    expect(providerCanStartSession(provider({ status: "auth-required" }))).toBe(false)
    expect(providerCanStartSession(provider({ status: "missing" }))).toBe(false)
    expect(providerCanStartSession(provider({ sessionCapable: false }))).toBe(false)
  })

  it("reports machine readiness independently from adapter support", () => {
    expect(providerStatusLabel(provider({ id: "claude-code", sessionCapable: false })))
      .toBe("Ready")
    expect(providerStatusLabel(provider({ status: "auth-required" }))).toBe("Sign in required")
    expect(providerStatusLabel(provider({ status: "missing" }))).toBe("Not installed")
    expect(providerStatusLabel(provider({ status: "unknown" }))).toBe("Detected")
    expect(providerStatusLabel(provider({}))).toBe("Ready")
  })

  it("prefers Codex without hard-coding it as the only provider", () => {
    const providers = [
      provider({ id: "claude-code", command: "claude" }),
      provider({ id: "codex" }),
    ]
    expect(preferredSessionProvider(providers)?.id).toBe("codex")
    expect(preferredSessionProvider([
      provider({ id: "codex", status: "missing" }),
      provider({ id: "claude-code", command: "claude" }),
    ])?.id).toBe("claude-code")
  })
})
