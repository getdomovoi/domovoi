import { describe, expect, it, vi } from "vitest"

import { readDaemonServiceStatus, removeDaemonService, type DaemonServiceDependencies } from "./desktop-service.js"
import type { ServiceEffects } from "./install.js"

// Security review round 12 of #576: a launchd job under Domovoi's label that
// was loaded from another plist is not Domovoi's service. It must not read as
// installed or running on Domovoi's behalf, and removal must not boot it out.
// Every effect is a fake; no service manager runs.
const agentPath = "/Users/dl/Library/LaunchAgents/sh.domovoi.domovoid.plist"

function effects(agentFileExists: boolean): DaemonServiceDependencies & ServiceEffects {
  return {
    platform: "darwin",
    home: "/Users/dl",
    uid: 501,
    user: "dl",
    runtimeFile: vi.fn(async () => "file" as const),
    claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
    claimProfile: vi.fn(() => ({ release: vi.fn() })),
    removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
    writeRemovalReceipt: vi.fn(),
    write: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    // launchctl print answers for the label with a job loaded from elsewhere.
    capture: vi.fn(async () => ({ code: 0, stdout: "\tpath = /Users/dl/Library/LaunchAgents/other.plist\n\tstate = running\n" })),
    exists: vi.fn(async (path: string) => path === agentPath ? agentFileExists : true),
    remove: vi.fn(async () => {}),
  }
}

describe("a launchd job under Domovoi's label loaded from another plist", () => {
  it("is not reported installed or running without Domovoi's plist, and removal boots nothing out", async () => {
    const fake = effects(false)
    expect(await readDaemonServiceStatus(fake)).toMatchObject({ installed: false, running: false })
    await removeDaemonService(fake)
    expect(fake.run).not.toHaveBeenCalledWith("launchctl", expect.arrayContaining(["bootout"]), expect.anything())
  })

  it("is not reported running beside Domovoi's plist, and removal boots nothing out", async () => {
    const fake = effects(true)
    expect(await readDaemonServiceStatus(fake)).toMatchObject({ running: false })
    await removeDaemonService(fake)
    expect(fake.run).not.toHaveBeenCalledWith("launchctl", expect.arrayContaining(["bootout"]), expect.anything())
  })
})
