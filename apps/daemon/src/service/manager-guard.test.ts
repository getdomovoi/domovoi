import { existsSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { serviceManagerRefusals, serviceManagerRefusalVariable as setupVariable, takeServiceManagerRefusals } from "../../vitest.setup.js"
import { OperationDeadline } from "../operation-deadline.js"
import { nodeServiceEffects } from "./install.js"
import { refuseRealServiceManagerUnderTest, serviceManagerRefusalVariable } from "./manager-guard.js"
import { removeScratchDirectory } from "../test-scratch.js"

// On 2026-10-16 two profile recovery tests failed on a Mac with the real login
// service loaded: they asked the real launchctl about the operator's own job.
// The daemon test setup now makes the real runner refuse, so a test that
// reaches launchctl, systemctl, loginctl or the Task Scheduler fails instead.

it("is armed by the daemon test setup under the name the runner reads", () => {
  expect(setupVariable).toBe(serviceManagerRefusalVariable)
  expect(process.env[serviceManagerRefusalVariable]).toBe(serviceManagerRefusals)
})

it.each(["run", "capture"] as const)("refuses the real %s runner before it starts anything", async (method) => {
  const marker = join(homedir(), `service-manager-${method}-ran`)
  const deadline = OperationDeadline.start(5_000)
  try {
    const effect = nodeServiceEffects()[method]
    await expect(effect(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], deadline))
      .rejects.toThrow(/daemon test reached the real service manager/)
  } finally { deadline.clear() }
  expect(existsSync(marker)).toBe(false)
  // Taken here, so the setup's own check after this test finds nothing.
  expect(takeServiceManagerRefusals(serviceManagerRefusals)).toEqual([expect.stringContaining(process.execPath)])
})

it("records what it refused, shortened, so a caught refusal still fails the test", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domovoi-refusals-"))
  try {
    const script = "A".repeat(500)
    expect(() => refuseRealServiceManagerUnderTest("powershell.exe", ["-EncodedCommand", script], { [serviceManagerRefusalVariable]: directory }))
      .toThrow(/daemon test reached the real service manager: powershell\.exe -EncodedCommand A+\.\.\./)
    expect(takeServiceManagerRefusals(directory)).toEqual([`powershell.exe -EncodedCommand ${"A".repeat(120)}...`])
    expect(takeServiceManagerRefusals(directory)).toEqual([])
  } finally { await removeScratchDirectory(directory) }
})

it("does nothing where the daemon test setup has not armed it", () => {
  expect(() => refuseRealServiceManagerUnderTest("launchctl", ["print", "gui/501"], {})).not.toThrow()
  expect(() => refuseRealServiceManagerUnderTest("launchctl", ["print", "gui/501"], { [serviceManagerRefusalVariable]: "" })).not.toThrow()
})
