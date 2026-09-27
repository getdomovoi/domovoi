import { basename } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createCursorAgentAdapter, createGrokAgentAdapter } from "./acp-factory.js"
import { CliProviderProbe, runProviderCommand, type ProviderCommandRunner } from "./providers.js"

// Every process the code under test asks for is recorded and refused, so no
// provider program can run here whatever the code does.
const launched = vi.hoisted(() => [] as string[])
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const refuse = (command: unknown): never => {
    launched.push(String(command))
    throw Object.assign(new Error(`spawn ${String(command)} ENOENT`), { code: "ENOENT" })
  }
  return { ...actual, spawn: refuse, execFile: refuse, execFileSync: refuse }
})

const acpCommands = new Set(["agent", "cursor-agent", "grok"])

const offReason = (name: string) =>
  `${name} is turned off in Domovoi for now. ${name} loads MCP servers, hooks and permission rules from the repository it works in, `
  + "and Domovoi does not load repository-brought configuration until a trust gate ships."

function fakeRunner() {
  return vi.fn<ProviderCommandRunner>(async () => ({ exitCode: 0, stdout: "1.0.0\n", stderr: "" }))
}

afterEach(() => {
  launched.length = 0
})

// Cursor and Grok load program-starting configuration from the repository and
// cannot be told not to, so until the trust gate ships the daemon does not run
// them for any reason.
describe("Cursor and Grok turned off", () => {
  it("reports both as unable to start without running them when every provider is probed", async () => {
    const run = fakeRunner()
    const detections = await new CliProviderProbe(run).inspect()

    expect(run.mock.calls.map(([command]) => basename(command)).filter((command) => acpCommands.has(command))).toEqual([])
    expect(detections).toContainEqual({ id: "cursor-agent", command: "agent", status: "unknown", problem: offReason("Cursor") })
    expect(detections).toContainEqual({ id: "grok", command: "grok", status: "unknown", problem: offReason("Grok") })
  })

  it.each([
    ["cursor-agent", "Cursor"],
    ["grok", "Grok"],
  ])("reports %s as unable to start without running it when it alone is probed", async (provider, name) => {
    const run = fakeRunner()
    const detection = await new CliProviderProbe(run).inspectProvider(provider)

    expect(run).not.toHaveBeenCalled()
    expect(detection).toMatchObject({ id: provider, status: "unknown", problem: offReason(name) })
  })

  it("runs nothing through the real provider command runner", async () => {
    await new CliProviderProbe(runProviderCommand).inspect()

    expect(launched.filter((command) => acpCommands.has(basename(command)))).toEqual([])
  })

  it.each([
    ["Cursor", createCursorAgentAdapter],
    ["Grok", createGrokAgentAdapter],
  ] as const)("refuses to connect %s or list its models without starting it", async (name, create) => {
    const run = fakeRunner()
    const createPeer = vi.fn()
    const adapter = create({ run, createPeer })

    await expect(adapter.connect()).rejects.toThrow(offReason(name))
    await expect(adapter.listModels()).rejects.toThrow(offReason(name))
    await expect(adapter.startThread({
      cwd: "/work/session",
      runtime: { provider: "grok", model: "m", reasoning: "none", permissionMode: "plan", auto: false },
    })).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    expect(createPeer).not.toHaveBeenCalled()
  })

  it.each([
    ["Cursor", createCursorAgentAdapter],
    ["Grok", createGrokAgentAdapter],
  ] as const)("starts no %s process through the default launcher", async (name, create) => {
    const adapter = create()

    await expect(adapter.connect()).rejects.toThrow(offReason(name))
    await expect(adapter.listModels()).rejects.toThrow(offReason(name))
    expect(launched).toEqual([])
  })
})
