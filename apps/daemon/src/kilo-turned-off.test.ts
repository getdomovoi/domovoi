import { basename } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

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

const kiloOffReason = "Kilo is turned off in Domovoi for now. Kilo's server can switch on a rule that allows every "
  + "tool, and it sends Domovoi no event when that happens, so Domovoi cannot show an approval card before a tool runs."

function fakeRunner() {
  return vi.fn<ProviderCommandRunner>(async () => ({ exitCode: 0, stdout: "1.0.0\n", stderr: "" }))
}

afterEach(() => {
  launched.length = 0
})

// Kilo's embedded server can switch on an allow-everything permission rule
// without a permission event, so the daemon does not run Kilo for any reason.
describe("Kilo turned off", () => {
  it("reports Kilo as unable to start without running it when every provider is probed", async () => {
    const run = fakeRunner()
    const detections = await new CliProviderProbe(run).inspect()

    expect(run.mock.calls.map(([command]) => basename(command))).not.toContain("kilo")
    expect(detections).toContainEqual({ id: "kilo", command: "kilo", status: "unknown", problem: kiloOffReason })
  })

  it("reports Kilo as unable to start without running it when it alone is probed", async () => {
    const run = fakeRunner()
    const detection = await new CliProviderProbe(run).inspectProvider("kilo")

    expect(run).not.toHaveBeenCalled()
    expect(detection).toEqual({ id: "kilo", command: "kilo", status: "unknown", problem: kiloOffReason })
  })

  it("runs no kilo through the real provider command runner", async () => {
    await new CliProviderProbe(runProviderCommand).inspect()

    expect(launched.map((command) => basename(command))).not.toContain("kilo")
  })

  it("keeps Cursor and Grok turned off when Kilo is probed as turned on", async () => {
    const run = fakeRunner()
    const detections = await new CliProviderProbe(run, { kiloTurnedOff: false }).inspect()

    expect(run.mock.calls.map(([command]) => basename(command))).toContain("kilo")
    expect(run.mock.calls.map(([command]) => basename(command))).not.toContain("grok")
    expect(detections.find(({ id }) => id === "kilo")).not.toHaveProperty("problem")
    expect(detections.find(({ id }) => id === "grok")).toHaveProperty("problem")
  })

  it("keeps Kilo turned off when Cursor and Grok are probed as turned on", async () => {
    const run = fakeRunner()
    const detections = await new CliProviderProbe(run, { acpProvidersTurnedOff: false }).inspect()

    expect(run.mock.calls.map(([command]) => basename(command))).toContain("grok")
    expect(run.mock.calls.map(([command]) => basename(command))).not.toContain("kilo")
    expect(detections).toContainEqual({ id: "kilo", command: "kilo", status: "unknown", problem: kiloOffReason })
  })
})
