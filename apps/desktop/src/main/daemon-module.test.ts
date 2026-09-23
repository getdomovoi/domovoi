import { describe, expect, it, vi } from "vitest"

import { daemonModuleExports, daemonModuleSpecifier, loadDaemonModule } from "./daemon-module.js"

// fetzy, 2026-09-23 (#577): the app and the login service share one copy of the
// daemon. A packaged app loads its in-app daemon from the runtime it ships in
// resources, the same files the service runs; nothing of the daemon is in the
// archive.
describe("where the in-app daemon is loaded from", () => {
  it("loads the shipped runtime in a packaged app", () => {
    expect(daemonModuleSpecifier({ isPackaged: true, resourcesPath: "/Applications/Domovoi.app/Contents/Resources" }))
      .toBe("file:///Applications/Domovoi.app/Contents/Resources/daemon-runtime/daemon/dist/public.js")
  })

  it("loads the workspace package when not packaged", () => {
    expect(daemonModuleSpecifier({ isPackaged: false, resourcesPath: "/ignored" })).toBe("@getdomovoi/daemon")
  })

  it("returns the module and says where it came from", async () => {
    const module = Object.fromEntries(daemonModuleExports.map((name) => [name, vi.fn()]))
    const importer = vi.fn(async () => module)
    const loaded = await loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, importer)
    expect(importer).toHaveBeenCalledWith("file:///r/daemon-runtime/daemon/dist/public.js")
    expect(loaded.from).toBe("file:///r/daemon-runtime/daemon/dist/public.js")
    expect(loaded.module.acquireLocalDaemon).toBe(module.acquireLocalDaemon)
  })

  it("refuses a module that lacks what the app uses, naming it", async () => {
    const importer = vi.fn(async () => ({ acquireLocalDaemon: vi.fn() }))
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, importer))
      .rejects.toThrow(/file:\/\/\/r\/daemon-runtime\/daemon\/dist\/public\.js is missing verifyLocalFleetClientRoute/)
  })
})
