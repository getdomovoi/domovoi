import { describe, expect, it } from "vitest"

import type { ProviderModel, ProviderRuntime, Runtime } from "@getdomovoi/protocol"

import {
  providerHandoffDescription,
  preferredSessionProvider,
  providerCanStartSession,
  providerStatusLabel,
  requiresProviderHandoff,
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

  // Desktop V2: the effort keeps its level when the new model reports the
  // same level, read by its shared word rather than the raw value.
  it("carries a level the new model reports under another value with the same word", () => {
    const thinking: Runtime = { ...runtime, provider: "claude-code", reasoning: "think-hard" }
    expect(selectRuntimeModel(thinking, { ...model(["low", "medium", "high"]), defaultReasoningEffort: "high" })).toMatchObject({
      provider: "codex",
      reasoning: "medium",
    })
  })

  // Only a model that names no default among its levels falls back to the
  // nearest level it reports.
  it("moves to the nearest reported level when the model names no default among its levels", () => {
    const max: Runtime = { ...runtime, provider: "opencode", reasoning: "max" }
    expect(selectRuntimeModel(max, { ...model(["low", "medium", "high"]), defaultReasoningEffort: "none" })).toMatchObject({
      reasoning: "high",
    })
    expect(selectRuntimeModel({ ...max, reasoning: "low" }, { ...model(["medium", "high"]), defaultReasoningEffort: "none" })).toMatchObject({
      reasoning: "medium",
    })
  })

  it("keeps the model default for a model that reports no levels", () => {
    expect(selectRuntimeModel(runtime, { ...model([]), defaultReasoningEffort: "none" })).toMatchObject({ reasoning: "none" })
  })

  it("requires a handoff only when the provider changes", () => {
    expect(requiresProviderHandoff(runtime, model([]))).toBe(false)
    expect(requiresProviderHandoff(runtime, { ...model([]), provider: "claude-code" })).toBe(true)
  })

  it("discloses what a provider handoff carries and leaves behind", () => {
    expect(providerHandoffDescription("Claude Code", "Claude Sonnet 4.6")).toBe(
      "Domovoi checkpoints this worktree and carries the thread, plan, diff, test results, and open annotations to Claude Code / Claude Sonnet 4.6. Hidden reasoning, provider caches, and private session metadata do not transfer.",
    )
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
    expect(providerStatusLabel(provider({ status: "missing" }))).toBe("Not found")
    expect(providerStatusLabel(provider({ status: "unknown" }))).toBe("Detected")
    expect(providerStatusLabel(provider({}))).toBe("Ready")
  })

  it("keeps a provider whose install cannot run sessions out of the launcher, and says so", () => {
    const outdated = provider({
      id: "claude-code",
      command: "claude",
      problem: "Update Claude Code to 2.1.263 or newer. The claude on this machine is 2.1.100.",
    })
    expect(providerCanStartSession(outdated)).toBe(false)
    expect(providerStatusLabel(outdated)).toBe("Cannot start")
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
