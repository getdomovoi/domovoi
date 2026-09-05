import { describe, expect, it } from "vitest"

import config, { daemonTestScheduling } from "../vitest.config.js"

describe("daemon test scheduling", () => {
  it("caps Windows workers so three heavy files cannot run together", () => {
    expect(daemonTestScheduling("win32")).toMatchObject({ maxWorkers: 2 })
  })

  it.each(["linux", "darwin"] as const)("keeps Vitest's worker default on %s", (platform) => {
    expect(daemonTestScheduling(platform)).not.toHaveProperty("maxWorkers")
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
