import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createProductionDaemon, type ProductionDaemonHandle } from "./production-daemon.js"

const homes: string[] = []
const handles: ProductionDaemonHandle[] = []

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map((handle) => handle.stop()))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe("production profile ownership", () => {
  it("refuses a second profile owner before either listener starts", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-profile-owner-"))
    homes.push(homeDirectory)
    const first = await createProductionDaemon({ environment: {}, homeDirectory })
    handles.push(first)

    // A different port must not turn the same session database into two
    // writable daemons. Both paths are the factory shipped to CLI and Desktop.
    const second = createProductionDaemon({
      environment: { DOMOVOI_PORT: "47832" }, homeDirectory,
    }).then((handle) => { handles.push(handle); return handle })

    await expect(second).rejects.toThrow(/profile.*already.*owned/i)
  })
})
