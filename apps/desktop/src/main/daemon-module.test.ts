import { describe, expect, it, vi } from "vitest"

import { DaemonRuntimeLoadError, daemonModuleExports, daemonModuleSpecifier, loadDaemonModule } from "./daemon-module.js"

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

  // #576 (2026-09-23): the handoff refusal check comes from the same runtime.
  it("exposes the service handoff check from the runtime", async () => {
    const module = Object.fromEntries(daemonModuleExports.map((name) => [name, vi.fn()]))
    const loaded = await loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => module)
    expect(loaded.module.readLocalServiceHandoffRefusal).toBe(module.readLocalServiceHandoffRefusal)
    const { readLocalServiceHandoffRefusal: _omitted, ...without } = module
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => without))
      .rejects.toThrow(/is missing readLocalServiceHandoffRefusal\. The shipped daemon runtime does not match this app\./)
  })

  // Ruled 2026-09-23 (#577, A): the service runtime version comes from the same runtime.
  it("exposes the service runtime version reader from the runtime", async () => {
    const module = Object.fromEntries(daemonModuleExports.map((name) => [name, vi.fn()]))
    const { readDaemonServiceRuntimeVersion: _omitted, ...without } = module
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => without))
      .rejects.toThrow(/is missing readDaemonServiceRuntimeVersion\./)
  })

  // Ruled 2026-09-23 (#577, B): the in-place update comes from the same runtime.
  it("exposes the in-place service update from the runtime", async () => {
    const module = Object.fromEntries(daemonModuleExports.map((name) => [name, vi.fn()]))
    const { updateDaemonService: _omitted, ...without } = module
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => without))
      .rejects.toThrow(/is missing updateDaemonService\./)
  })

  it("names the path when the runtime cannot be imported, as a load error", async () => {
    const failed = loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => { throw new Error("Cannot find module") })
    await expect(failed).rejects.toBeInstanceOf(DaemonRuntimeLoadError)
    await expect(failed).rejects.toThrow("file:///r/daemon-runtime/daemon/dist/public.js could not be imported: Cannot find module")
  })

  it("reports missing exports as a load error too", async () => {
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => ({}))).rejects.toBeInstanceOf(DaemonRuntimeLoadError)
  })
})
