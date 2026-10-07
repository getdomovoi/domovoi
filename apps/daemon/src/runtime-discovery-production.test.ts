import { afterEach, describe, expect, it, vi } from "vitest"

import { demoWorkspace, devicePairResultSchema, protocolVersion, type ProviderModel } from "@getdomovoi/protocol"

import type { AgentAdapter } from "./agents.js"
import type { ProviderDetection } from "./providers.js"
import { fleetProductionHarness, sessionAgent } from "./test-fleet-production.js"
import { waitForDaemon } from "./test-wait-for.js"
import { DomovoiDaemon } from "./server.js"

const harness = fleetProductionHarness()
afterEach(harness.cleanup)
const budgetMs = process.platform === "win32" ? 40_000 : 30_000

function model(provider = "codex", id = "discovered-model"): ProviderModel {
  return { provider, id, displayName: id, description: "Provider boundary", supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high", isDefault: true }
}
function agent(provider = "codex") {
  return { ...sessionAgent, listModels: vi.fn(async () => [model(provider)]),
    startThread: vi.fn(async (_input: Parameters<AgentAdapter["startThread"]>[0]) => "discovered-thread") }
}
function detection(id: string, status: ProviderDetection["status"] = "ready"): ProviderDetection {
  return { id, command: id, status }
}

describe("runtime discovery over production daemon sockets", () => {
  it.each([{ levels: ["low", "high"] }, { levels: [] }])("uses unset without a reported default with $levels", async ({ levels }) => {
    const claude = agent("claude-code")
    const { defaultReasoningEffort: _default, ...noDefault } = model("claude-code")
    claude.listModels.mockResolvedValue([{ ...noDefault, supportedReasoningEfforts: levels }])
    const target = await harness.machine("no effort default", undefined, {
      agents: { "claude-code": claude }, providerProbe: { inspect: async () => [detection("claude-code")] },
    })
    const discovered = await target.root.ok("runtime.discover", { provider: "claude-code", client: "cli" })
    expect(discovered).toMatchObject({ status: "ready", defaultRuntime: { reasoning: "unset" } })
    if (discovered.status !== "ready") throw new Error("No runtime returned")
    expect(discovered.models[0]).not.toHaveProperty("defaultReasoningEffort")
    await target.root.ok("project.open", { path: await harness.repository("no-default-project"), client: "cli" })
    for (const runtime of [discovered.defaultRuntime, { ...discovered.defaultRuntime, model: "default", reasoning: levels.length > 0 ? "retired" : "medium" }]) {
      const created = await target.root.ok("session.create", { title: "Model setting", runtime, client: "cli" })
      expect(created.sessions.find(({ id }) => id === created.activeSessionId)?.runtime).toEqual(discovered.defaultRuntime)
      expect(claude.startThread).toHaveBeenLastCalledWith(expect.objectContaining({ runtime: discovered.defaultRuntime }))
    }
    if (levels.length > 0) {
      const created = await target.root.ok("session.create", { title: "Explicit effort", client: "cli",
        runtime: { ...discovered.defaultRuntime, reasoning: "high" } })
      expect(created.sessions.find(({ id }) => id === created.activeSessionId)?.runtime.reasoning).toBe("high")
      expect((await target.root.call("session.create", { title: "Invalid effort", client: "cli",
        runtime: { ...discovered.defaultRuntime, reasoning: "invented" } })).error?.code).toBe(-32602)
    }
  }, budgetMs)

  it.each(["session.create", "session.setRuntime"] as const)("refuses invented effort on %s when the model has no effort support", async (method) => {
    const claude = agent("claude-code")
    const { defaultReasoningEffort: _default, ...noDefault } = model("claude-code")
    claude.listModels.mockResolvedValue([{ ...noDefault, supportedReasoningEfforts: [] }])
    const target = await harness.machine("no effort support", undefined, {
      agents: { "claude-code": claude }, providerProbe: { inspect: async () => [detection("claude-code")] },
    })
    await target.root.ok("project.open", { path: await harness.repository("no-effort-project"), client: "cli" })
    const runtime = { provider: "claude-code", model: "discovered-model", reasoning: "unset", permissionMode: "ask", auto: false } as const
    const created = await target.root.ok("session.create", { title: "Model setting", runtime, client: "cli" })
    const sessionId = created.activeSessionId!
    const accepted = await target.root.ok("session.setRuntime", { sessionId, runtime, client: "cli" })
    expect(accepted.sessions.find(({ id }) => id === sessionId)?.runtime).toEqual(runtime)
    for (const model of ["discovered-model", "default"]) {
      const invalidRuntime = { ...runtime, model, reasoning: "invented" }
      const refused = method === "session.create"
        ? await target.root.call(method, { title: "Invalid effort", runtime: invalidRuntime, client: "cli" })
        : await target.root.call(method, { sessionId, runtime: invalidRuntime, client: "cli" })
      expect(refused.error).toEqual({ code: -32602, message: "Reasoning effort is not supported by the selected model" })
    }
  }, budgetMs)

  it.each(["session.restartProviderThread", "session.setRuntime"] as const)("normalizes stored medium to unset on %s when the model has no effort support", async (method) => {
    const snapshot = structuredClone(demoWorkspace)
    const session = snapshot.sessions[0]!
    session.runtime = { provider: "claude-code", model: "discovered-model", reasoning: "medium", permissionMode: "build", auto: false }
    session.state = "idle"
    session.workspacePath = await harness.scratch()
    delete session.providerThreadId
    delete session.activeTurnId
    const claude = agent("claude-code")
    const { defaultReasoningEffort: _default, ...noDefault } = model("claude-code")
    claude.listModels.mockResolvedValue([{ ...noDefault, supportedReasoningEfforts: [] }])
    const daemon = new DomovoiDaemon({ port: 0, profileDirectory: await harness.scratch(),
      store: { load: () => snapshot, save: vi.fn(), close: vi.fn() },
      agents: { "claude-code": claude }, providerProbe: { inspect: async () => [detection("claude-code")] },
    })
    try {
      const address = await daemon.start()
      const client = await harness.connect(`ws://${address.host}:${address.port}/rpc`)
      await client.ok("system.hello", { client: "cli", clientVersion: "0.0.1", protocolVersion, authToken: daemon.authToken })
      const updated = method === "session.setRuntime"
        ? await client.ok(method, { sessionId: session.id, client: "cli", runtime: session.runtime })
        : await client.ok(method, { sessionId: session.id, client: "cli" })
      expect(updated.sessions.find(({ id }) => id === session.id)?.runtime.reasoning).toBe("unset")
      if (method === "session.restartProviderThread") {
        expect(claude.startThread).toHaveBeenLastCalledWith(expect.objectContaining({ runtime: { ...session.runtime, reasoning: "unset" } }))
      }
      client.socket.terminate()
    } finally { await daemon.stop() }
  }, budgetMs)

  it("lets a paired phone choose a runtime, create a real Git worktree and recover it from SQLite", async () => {
    const codex = agent()
    codex.listModels.mockResolvedValue([{ ...model("codex", "alternate"), isDefault: false }, model()])
    const options = { agents: { codex }, providerProbe: { inspect: async () => [detection("codex")] } }
    const target = await harness.machine("phone execution machine", undefined, options)
    const provisioner = await harness.connect(target.address.url)
    expect((await provisioner.call("runtime.discover", { provider: "codex", client: "phone" })).error?.code).toBe(-32001)
    await provisioner.ok("system.hello", { client: "phone", clientVersion: "0.0.1", protocolVersion, authToken: target.handle.authToken })
    const pairing = devicePairResultSchema.parse(await provisioner.ok("device.pair", { label: "phone", client: "phone" }))
    provisioner.socket.terminate()
    const phone = await harness.connect(target.address.url)
    await phone.ok("system.hello", { client: "phone", clientVersion: "0.0.1", protocolVersion, authToken: pairing.token })
    const discovered = await phone.ok("runtime.discover", { provider: "codex", client: "phone" })
    expect(discovered).toMatchObject({ machineId: target.id, provider: "codex", status: "ready",
      defaultRuntime: { provider: "codex", model: "discovered-model", reasoning: "high", permissionMode: "ask", auto: false } })
    if (discovered.status !== "ready") throw new Error("No runtime returned")
    expect(discovered.models).toHaveLength(2)
    expect(codex.startThread).not.toHaveBeenCalled()
    await phone.ok("project.open", { path: await harness.repository("phone-project"), client: "phone" })
    const created = await phone.ok("session.create", { title: "Created on phone", runtime: discovered.defaultRuntime, client: "phone" })
    const session = created.sessions.find(({ id }) => id === created.activeSessionId)!
    expect(session.runtime).toEqual(discovered.defaultRuntime)
    expect(codex.startThread).toHaveBeenCalledWith({ cwd: session.workspacePath, runtime: discovered.defaultRuntime })
    phone.socket.terminate()
    target.root.socket.terminate()
    await target.handle.stop()
    const restarted = await target.start(options)
    expect((await restarted.root.ok("workspace.get", {})).sessions.find(({ id }) => id === session.id)?.runtime)
      .toEqual(discovered.defaultRuntime)
  }, budgetMs)

  it.each(["auth-required", "missing", "unknown"] as const)("refuses fresh %s readiness even after a successful cached discovery", async (status) => {
    const codex = agent()
    let current: ProviderDetection["status"] = "ready"
    const target = await harness.machine("readiness", undefined, {
      agents: { codex }, providerProbe: { inspect: async () => [detection("codex", current)] },
    })
    expect((await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })).status).toBe("ready")
    await target.root.ok("project.open", { path: await harness.repository("readiness-project"), client: "cli" })
    current = status
    const refusal = await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })
    expect(refusal).toMatchObject({ status: "unavailable", reason: status === "unknown" ? "readiness-unknown" : status })
    expect(refusal).not.toHaveProperty("models")
    expect(refusal).not.toHaveProperty("defaultRuntime")
    expect(codex.listModels).toHaveBeenCalledOnce()
    expect(codex.startThread).not.toHaveBeenCalled()
    expect((await target.root.call("session.create", { title: "Stale selection", client: "cli",
      runtime: { provider: "codex", model: "discovered-model", reasoning: "high", permissionMode: "ask", auto: false },
    })).error?.code).toBe(-32602)
    expect((await target.root.ok("workspace.get", {})).sessions).toEqual([])
    expect(codex.startThread).not.toHaveBeenCalled()
  }, budgetMs)

  it("bounds stalled discovery, serves another provider and a mutation, and fences late cache writes", async () => {
    const codex = agent()
    let finishLate: (models: ProviderModel[]) => void = () => { throw new Error("Discovery did not start") }
    codex.listModels.mockImplementationOnce(() => new Promise((resolve) => { finishLate = resolve }))
    const claude = agent("claude-code")
    const target = await harness.machine("bounded discovery", undefined, {
      agents: { codex, "claude-code": claude }, runtimeDiscoveryTimeoutMs: 500,
      providerProbe: { inspect: async () => [detection("codex"), detection("claude-code")] },
    })
    const path = await harness.repository("responsive")
    const stalled = target.root.ok("runtime.discover", { provider: "codex", client: "cli" })
    void stalled.catch(() => {})
    await vi.waitFor(() => expect(codex.listModels).toHaveBeenCalledOnce(), { timeout: 2_000 })
    expect((await target.root.ok("runtime.discover", { provider: "claude-code", client: "cli" })).status).toBe("ready")
    await target.root.ok("project.open", { path, client: "cli" })
    const refused = await stalled
    expect(refused).toMatchObject({ status: "unavailable", reason: "timeout", action: "retry", retryable: true })
    const retried = await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })
    expect(retried).toMatchObject({ status: "ready", defaultRuntime: { model: "discovered-model" } })
    finishLate([model("codex", "stale-model")])
    await target.root.ok("workspace.get", {})
    expect(await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })).toEqual(retried)
    expect(codex.listModels).toHaveBeenCalledTimes(2)
  }, budgetMs)

  it("coalesces concurrent discovery and supplies Plan when Ask cannot be enforced", async () => {
    const grok: AgentAdapter = { ...agent("grok"), permissionCapabilities: { ask: "unsupported", buildAuto: "unsupported" } }
    let finish: (models: ProviderModel[]) => void = () => {}
    const listing = vi.fn(() => new Promise<ProviderModel[]>((resolve) => { finish = resolve }))
    grok.listModels = listing
    const target = await harness.machine("coalesced discovery", undefined, {
      agents: { grok }, providerProbe: { inspect: async () => [detection("grok")] },
    })
    const first = target.root.call("runtime.discover", { provider: "grok", client: "cli" })
    const second = target.root.call("runtime.discover", { provider: "grok", client: "cli" })
    await target.root.ok("workspace.get", {})
    await vi.waitFor(() => expect(listing).toHaveBeenCalledOnce(), { timeout: 2_000 })
    finish([{ ...model("grok"), isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: "none" }])
    expect((await first).result).toEqual((await second).result)
    expect((await first).result).toMatchObject({ status: "ready", permissionModes: ["plan", "build"], supportsAuto: false,
      defaultRuntime: { reasoning: "none", permissionMode: "plan", auto: false } })
    expect(await target.root.ok("runtime.models", { provider: "grok", client: "cli" })).toHaveLength(1)
    expect(listing).toHaveBeenCalledOnce()
  }, budgetMs)

  it.each(["empty", "malformed", "refused", "expired-auth"] as const)("reports %s catalogs without leaking provider output, then retries", async (scenario) => {
    const codex = agent()
    if (scenario === "empty") codex.listModels.mockResolvedValueOnce([])
    else if (scenario === "malformed") codex.listModels.mockResolvedValueOnce([{ ...model(), id: "x".repeat(257) }])
    else codex.listModels.mockRejectedValueOnce(new Error(`${scenario === "expired-auth" ? "401 unauthenticated" : "refused"}: token=private-provider-output`))
    const target = await harness.machine("refused discovery", undefined, {
      agents: { codex }, providerProbe: { inspect: async () => [detection("codex")] },
    })
    const result = await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })
    expect(result).toMatchObject({ status: "unavailable", reason: scenario === "empty" ? "no-models"
      : scenario === "expired-auth" ? "auth-required" : "discovery-failed" })
    expect(JSON.stringify(result)).not.toContain("private-provider-output")
    expect(result).not.toHaveProperty("models")
    expect((await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })).status).toBe("ready")
    expect(codex.listModels).toHaveBeenCalledTimes(2)
  }, budgetMs)

  it("reports the PATH the probe searched on the machine, so a client can say where it looked", async () => {
    const target = await harness.machine("searched path", undefined, {
      agents: { codex: agent() }, providerProbe: { inspect: async () => [], searchPath: "/usr/bin:/bin:/usr/sbin:/sbin" },
    })
    // The readiness refresh runs in-process after the harness answers.
    await waitForDaemon(async () => {
      expect((await target.root.ok("workspace.get", {})).machine.toolPath).toBe("/usr/bin:/bin:/usr/sbin:/sbin")
    })
    const bare = await harness.machine("bare probe", undefined, {
      agents: { codex: agent() }, providerProbe: { inspect: async () => [] },
    })
    expect((await bare.root.ok("workspace.get", {})).machine.toolPath).toBeUndefined()
  }, budgetMs)

  it("refuses providers without an adapter or verified readiness", async () => {
    const target = await harness.machine("unsupported discovery", undefined, {
      agents: { codex: agent() }, providerProbe: { inspect: async () => [] },
    })
    expect(await target.root.ok("runtime.discover", { provider: "other", client: "cli" }))
      .toMatchObject({ status: "unavailable", reason: "unsupported", action: "choose-provider" })
    expect(await target.root.ok("runtime.discover", { provider: "codex", client: "cli" }))
      .toMatchObject({ status: "unavailable", reason: "readiness-unknown" })
  }, budgetMs)

  it("bounds readiness separately from snapshot refresh and discards its late result", async () => {
    const codex = agent()
    let slow = false
    let finish: (detections: ProviderDetection[]) => void = () => {}
    const target = await harness.machine("slow readiness", undefined, {
      agents: { codex }, runtimeDiscoveryTimeoutMs: 100,
      providerProbe: { inspect: async () => slow ? new Promise((resolve) => { finish = resolve }) : [detection("codex")] },
    })
    expect((await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })).status).toBe("ready")
    slow = true
    expect(await target.root.ok("runtime.discover", { provider: "codex", client: "cli" }))
      .toMatchObject({ status: "unavailable", reason: "timeout" })
    slow = false
    expect((await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })).status).toBe("ready")
    finish([detection("codex", "auth-required")])
    expect((await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })).status).toBe("ready")
  }, budgetMs)

  it("does not begin model discovery when connection setup finishes after the end-to-end deadline", async () => {
    const codex = agent()
    let finish: () => void = () => {}
    const connect = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const target = await harness.machine("slow setup", undefined, {
      agents: { codex: { ...codex, connect } }, runtimeDiscoveryTimeoutMs: 100,
      providerProbe: { inspect: async () => [detection("codex")] },
    })
    expect(await target.root.ok("runtime.discover", { provider: "codex", client: "cli" }))
      .toMatchObject({ status: "unavailable", reason: "timeout" })
    finish()
    await target.root.ok("workspace.get", {})
    expect(codex.listModels).not.toHaveBeenCalled()
    expect((await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })).status).toBe("ready")
    expect(connect).toHaveBeenCalledOnce()
  }, budgetMs)

  it("cancels an in-flight catalog when its daemon stops", async () => {
    let signal: AbortSignal | undefined
    const codex: AgentAdapter = { ...agent(), listModels: async (input) => {
      signal = input
      return new Promise((_resolve, reject) => input!.addEventListener("abort", () => reject(input!.reason), { once: true }))
    } }
    const target = await harness.machine("shutdown discovery", undefined, {
      agents: { codex }, providerProbe: { inspect: async () => [detection("codex")] },
    })
    const listing = target.root.call("runtime.discover", { provider: "codex", client: "cli" }).catch(() => undefined)
    await vi.waitFor(() => expect(signal).toBeDefined(), { timeout: 2_000 })
    expect(signal?.aborted).toBe(false)
    await target.handle.stop()
    expect(signal?.aborted).toBe(true)
    await listing
  }, budgetMs)

  it("does not wait for another provider's readiness probe", async () => {
    const inspectProvider = vi.fn(async (provider: string, signal?: AbortSignal) => {
      if (provider === "grok") return new Promise<ProviderDetection>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
      })
      return detection(provider)
    })
    const target = await harness.machine("independent readiness", undefined, {
      agents: { codex: agent(), grok: agent("grok") }, runtimeDiscoveryTimeoutMs: 500,
      providerProbe: { inspect: async () => [], inspectProvider },
    })
    let grokFinished = false
    const grok = target.root.call("runtime.discover", { provider: "grok", client: "cli" }).then((reply) => {
      grokFinished = true
      return reply
    })
    expect((await target.root.ok("runtime.discover", { provider: "codex", client: "cli" })).status).toBe("ready")
    expect(grokFinished).toBe(false)
    expect((await grok).result).toMatchObject({ status: "unavailable", reason: "timeout" })
  }, budgetMs)
})
