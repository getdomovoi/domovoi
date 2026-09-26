import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

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

  // Security review of #577 (P1): the profile check comes from the same runtime.
  it("exposes the service profile check from the runtime", async () => {
    const module = Object.fromEntries(daemonModuleExports.map((name) => [name, vi.fn()]))
    const { serviceProfileMismatch: _omitted, ...without } = module
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => without))
      .rejects.toThrow(/is missing serviceProfileMismatch\./)
  })

  // #576: the handoff fence the service calls take comes from the same runtime.
  it("exposes the service handoff fence from the runtime", async () => {
    const module = Object.fromEntries(daemonModuleExports.map((name) => [name, vi.fn()]))
    const { holdServiceHandoffFence: _omitted, ...without } = module
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => without))
      .rejects.toThrow(/is missing holdServiceHandoffFence\./)
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

  // Owner ruling 2026-09-26 (#577, A): the values the first module held reach
  // the run-time daemon's own capture, and only a runtime that loads gets them.
  it("hands the held credentials to the run-time daemon's capture once it loads", async () => {
    const module = Object.fromEntries(daemonModuleExports.map((name) => [name, vi.fn()]))
    const held = { DOMOVOI_AUTH_TOKEN: "placeholder-held-value" }
    const take = vi.fn(() => held)
    const homeDirectory = () => "/Users/dana"
    await loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => module, { take, homeDirectory })
    expect(take).toHaveBeenCalledOnce()
    expect(module.captureInheritedCredentials).toHaveBeenCalledWith(homeDirectory, held)

    const refused = vi.fn(() => held)
    const { captureInheritedCredentials: _capture, ...without } = module
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: "/r" }, async () => without, { take: refused, homeDirectory }))
      .rejects.toThrow(/is missing captureInheritedCredentials\./)
    expect(refused).not.toHaveBeenCalled()
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

// Security review of #577 (P2): a packaged app imports its daemon only from
// files inside its own resources that match the digests packaging recorded in
// app.asar, and hands over the held credentials only after that. What it
// proves: the dist files it imports are the ones this build shipped. It does
// not cover the dependencies under node_modules beyond where that directory
// resolves, and it does not hold against a process running as the same user,
// which can rewrite app.asar as well (ruled outside the threat model).
describe("a packaged app loads only the daemon this build shipped", () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  const publicModule = `${daemonModuleExports.map((name) => `export function ${name}() {}`).join("\n")}\n`

  async function packagedApp() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-packaged-")))
    roots.push(root)
    const resourcesPath = join(root, "Resources")
    const appPath = join(resourcesPath, "app.asar")
    const daemon = join(resourcesPath, "daemon-runtime", "daemon")
    await mkdir(join(daemon, "dist"), { recursive: true })
    await mkdir(join(daemon, "node_modules"), { recursive: true })
    await writeFile(join(daemon, "package.json"), "{\"type\":\"module\"}\n")
    await writeFile(join(daemon, "dist", "public.js"), publicModule)
    await writeFile(join(daemon, "dist", "chunk-A.js"), "export const a = 1\n")
    const digests: Record<string, string> = {}
    for (const name of await readdir(join(daemon, "dist"))) digests[name] = createHash("sha256").update(await readFile(join(daemon, "dist", name))).digest("hex")
    await mkdir(join(appPath, "daemon-runtime-manifests"), { recursive: true })
    await writeFile(join(appPath, "daemon-runtime-manifests", `${process.platform}-${process.arch}.json`), JSON.stringify({ version: 1, dist: digests }))
    return { root, resourcesPath, appPath, daemon }
  }

  const credentials = () => ({ take: vi.fn(() => ({})), homeDirectory: () => "/Users/dana" })

  it("imports the shipped daemon when its files match the build, then hands over the credentials", async () => {
    const app = await packagedApp()
    const handOff = credentials()
    const loaded = await loadDaemonModule({ isPackaged: true, resourcesPath: app.resourcesPath, appPath: app.appPath }, undefined, handOff)
    expect(typeof loaded.module.acquireLocalDaemon).toBe("function")
    expect(handOff.take).toHaveBeenCalledOnce()
  })

  it("refuses a changed file before importing it or handing anything over", async () => {
    const app = await packagedApp()
    await writeFile(join(app.daemon, "dist", "public.js"), `throw new Error("the changed file ran")\n${publicModule}`)
    const handOff = credentials()
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: app.resourcesPath, appPath: app.appPath }, undefined, handOff))
      .rejects.toThrow(/dist[/\\]public\.js does not match this build\./)
    expect(handOff.take).not.toHaveBeenCalled()
  })

  it("refuses a file this build did not ship", async () => {
    const app = await packagedApp()
    await writeFile(join(app.daemon, "dist", "extra.js"), "export {}\n")
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: app.resourcesPath, appPath: app.appPath }, undefined, credentials()))
      .rejects.toThrow(/does not hold the files this build shipped\./)
  })

  it("refuses dist or node_modules reached through a link that leaves the resources, even with matching files", async () => {
    for (const part of ["dist", "node_modules"]) {
      const app = await packagedApp()
      const outside = join(app.root, "outside", part)
      await mkdir(join(app.root, "outside"), { recursive: true })
      await (await import("node:fs/promises")).rename(join(app.daemon, part), outside)
      await symlink(outside, join(app.daemon, part), process.platform === "win32" ? "junction" : "dir")
      const handOff = credentials()
      await expect(loadDaemonModule({ isPackaged: true, resourcesPath: app.resourcesPath, appPath: app.appPath }, undefined, handOff), part)
        .rejects.toThrow(new RegExp(`${part} leads outside this app's resources\\.`))
      expect(handOff.take, part).not.toHaveBeenCalled()
    }
  })

  it("refuses a manifest that is not a digest manifest", async () => {
    const app = await packagedApp()
    await writeFile(join(app.appPath, "daemon-runtime-manifests", `${process.platform}-${process.arch}.json`), "[]")
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: app.resourcesPath, appPath: app.appPath }, undefined, credentials()))
      .rejects.toThrow(/is not a digest manifest\./)
  })

  it("refuses a package with no recorded digests", async () => {
    const app = await packagedApp()
    await rm(join(app.appPath, "daemon-runtime-manifests"), { recursive: true })
    await expect(loadDaemonModule({ isPackaged: true, resourcesPath: app.resourcesPath, appPath: app.appPath }, undefined, credentials()))
      .rejects.toBeInstanceOf(DaemonRuntimeLoadError)
  })
})
