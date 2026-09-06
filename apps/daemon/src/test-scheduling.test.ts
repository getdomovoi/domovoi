import { describe, expect, it } from "vitest"

import config, { daemonTestScheduling, localDaemonBudgetMs } from "../vitest.config.js"

describe("daemon test scheduling", () => {
  it("caps Windows workers so three heavy files cannot run together", () => {
    expect(daemonTestScheduling("win32")).toMatchObject({ maxWorkers: 2 })
  })

  it.each(["linux", "darwin"] as const)("keeps Vitest's worker default on %s", (platform) => {
    expect(daemonTestScheduling(platform)).not.toHaveProperty("maxWorkers")
  })

  it.each(["win32", "linux", "darwin"] as const)("keeps the local daemon budget inside the %s test timeout", (platform) => {
    expect(localDaemonBudgetMs(platform)).toBeLessThan(daemonTestScheduling(platform).testTimeout)
  })

  // Worst passing CI run of the heaviest local daemon test, which spends this
  // budget three separate times: 5845 ms on Windows, 1344 ms on Ubuntu.
  it.each([["win32", 5_845], ["linux", 1_344]] as const)("clears the worst %s run measured in CI", (platform, worst) => {
    expect(localDaemonBudgetMs(platform)).toBeGreaterThan(worst)
  })

  it("stays under the budget a production daemon start uses for the same work", () => {
    expect(localDaemonBudgetMs("win32")).toBeLessThan(30_000)
  })

  it("applies the scheduling policy to the actual runner config", () => {
    expect(config.test).toMatchObject(daemonTestScheduling(process.platform))
    if (process.platform === "win32") {
      expect(config.test).toHaveProperty("maxWorkers", 2)
    } else {
      expect(config.test).not.toHaveProperty("maxWorkers")
    }
  })
})
