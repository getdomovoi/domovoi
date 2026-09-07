import { describe, expect, it } from "vitest"

import { isRefusedWithoutPersistence, protocolVersion, rpcMethods } from "./index.js"

const model = {
  provider: "codex", id: "discovered-model", displayName: "Discovered model", description: "",
  supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high", isDefault: true,
}
const ready = {
  machineId: `machine-${"a".repeat(32)}`, provider: "codex", status: "ready",
  models: [model], permissionModes: ["ask", "plan", "build"], supportsAuto: false,
  defaultRuntime: { provider: "codex", model: model.id, reasoning: "high", permissionMode: "ask", auto: false },
}

describe("runtime discovery contract", () => {
  it("adds a read-only, machine-local phone call without changing the wire version", () => {
    expect(protocolVersion).toBe("0.5.0")
    expect(isRefusedWithoutPersistence("runtime.discover")).toBe(false)
    const schema = rpcMethods["runtime.discover"].params
    expect(schema.parse({ provider: "codex", client: "phone" })).toEqual({ provider: "codex", client: "phone" })
    for (const params of [{ provider: " ", client: "phone" }, { provider: "codex" },
      { provider: "codex", client: "phone", projectId: "other" },
      { provider: "codex", client: "phone", machineId: ready.machineId }]) {
      expect(schema.safeParse(params).success).toBe(false)
    }
  })

  it("validates a default clients can submit unchanged to session.create", () => {
    expect(rpcMethods["runtime.discover"].result.parse(ready)).toEqual(ready)
    expect(rpcMethods["session.create"].params.parse({
      title: "Phone session", client: "phone", runtime: ready.defaultRuntime,
    }).runtime).toEqual(ready.defaultRuntime)
  })

  it("rejects contradictory choices, defaults and permission facts", () => {
    for (const patch of [
      { models: [] }, { models: [model, model] },
      { models: [{ ...model, provider: "other" }] },
      { models: [{ ...model, id: "x".repeat(257) }] },
      { defaultRuntime: { ...ready.defaultRuntime, model: "invented" } },
      { defaultRuntime: { ...ready.defaultRuntime, provider: "other" } },
      { defaultRuntime: { ...ready.defaultRuntime, reasoning: "invented" } },
      { defaultRuntime: { ...ready.defaultRuntime, permissionMode: "build", auto: true } },
      { permissionModes: ["plan", "build"] }, { permissionModes: ["ask", "ask"] },
      { unexpected: true },
    ]) expect(rpcMethods["runtime.discover"].result.safeParse({ ...ready, ...patch }).success).toBe(false)
  })

  it("carries a refusal with an action and no selectable runtime", () => {
    const refusal = {
      machineId: ready.machineId, provider: "codex", status: "unavailable", reason: "auth-required",
      action: "sign-in", retryable: false, message: "Sign in to this provider on the execution machine, then retry discovery.",
    }
    expect(rpcMethods["runtime.discover"].result.parse(refusal)).toEqual(refusal)
    for (const patch of [{ models: [model] }, { defaultRuntime: ready.defaultRuntime }, { reason: "whatever" },
      { message: "" }, { action: "retry" }, { retryable: true }]) {
      expect(rpcMethods["runtime.discover"].result.safeParse({ ...refusal, ...patch }).success).toBe(false)
    }
  })
})
