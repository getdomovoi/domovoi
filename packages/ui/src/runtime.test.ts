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
  it("keeps unset when switching between Claude models with no reported default", () => {
    const claude: Runtime = { ...runtime, provider: "claude-code", model: "sonnet", reasoning: "unset" }
    const target: ProviderModel = {
      provider: "claude-code", id: "opus", displayName: "Opus", description: "",
      supportedReasoningEfforts: ["unset", "low", "medium", "high", "max"], isDefault: false,
    }
    expect(selectRuntimeModel(claude, target)).toEqual({ ...claude, model: "opus" })
  })

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
    const shouted: Runtime = { ...runtime, provider: "claude-code", reasoning: "HIGH" }
    expect(selectRuntimeModel(shouted, { ...model(["low", "medium", "high"]), defaultReasoningEffort: "medium" })).toMatchObject({
      provider: "codex",
      reasoning: "high",
    })
  })

  // Ruling Q31: xhigh is Extra high on every harness, so it carries from
  // codex to a claude-code model that reports it.
  it("carries Extra high between codex and claude-code", () => {
    const extra: Runtime = { ...runtime, reasoning: "xhigh" }
    expect(selectRuntimeModel(extra, { ...model(["low", "high", "xhigh", "max"]), provider: "claude-code", defaultReasoningEffort: "high" })).toMatchObject({
      provider: "claude-code",
      reasoning: "xhigh",
    })
  })

  // The claude-code names of the 2026-09-23 scale are not levels the daemon
  // reports, so they carry no word and land on the new model's default.
  it("moves a level with no word to the new model's default", () => {
    const retired: Runtime = { ...runtime, provider: "claude-code", reasoning: "think-hard" }
    expect(selectRuntimeModel(retired, { ...model(["low", "medium", "high"]), defaultReasoningEffort: "high" })).toMatchObject({
      provider: "codex",
      reasoning: "high",
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

  // Desktop V2's rank runs Model's own, None, Minimal, Low, Medium, High,
  // Extra high, Max, so a level carried onto a model with no default among
  // its levels lands on the nearest rung it reports.
  it("ranks the design's whole vocabulary when it moves to the nearest level", () => {
    const extra: Runtime = { ...runtime, reasoning: "xhigh" }
    expect(selectRuntimeModel(extra, { ...model(["minimal", "high", "max"]), defaultReasoningEffort: "unknown" })).toMatchObject({
      reasoning: "high",
    })
    const none: Runtime = { ...runtime, reasoning: "none" }
    expect(selectRuntimeModel(none, { ...model(["minimal", "high"]), provider: "claude-code", defaultReasoningEffort: "unknown" })).toMatchObject({
      reasoning: "minimal",
    })
  })

  // The launcher names the new provider before its models arrive, so the
  // caller says which scale the current level was chosen on.
  it("reads the level on the scale of the provider it came from", () => {
    const named: Runtime = { ...runtime, reasoning: "unset" }
    const kilo = { ...model(["high", "none"]), provider: "kilo", defaultReasoningEffort: "unknown" }
    expect(selectRuntimeModel(named, kilo, "opencode")).toMatchObject({ reasoning: "none" })
    expect(selectRuntimeModel(named, kilo)).toMatchObject({ reasoning: "high" })
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
