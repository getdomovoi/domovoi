import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

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

  // The daemon's public module imports a library from node_modules, so a load
  // proves the library came from the checked copy too.
  const publicModule = `import { dependency } from "dep"\n${daemonModuleExports.map((name) => `export function ${name}() { return dependency }`).join("\n")}\n`

  async function packagedApp() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-packaged-")))
    roots.push(root)
    const resourcesPath = join(root, "Resources")
    const appPath = join(resourcesPath, "app.asar")
    const daemon = join(resourcesPath, "daemon-runtime", "daemon")
    await mkdir(join(daemon, "dist"), { recursive: true })
    await mkdir(join(daemon, "node_modules", "dep"), { recursive: true })
    await writeFile(join(daemon, "package.json"), "{\"type\":\"module\"}\n")
    await writeFile(join(daemon, "dist", "public.js"), publicModule)
    await writeFile(join(daemon, "dist", "chunk-A.js"), "export const a = 1\n")
    await writeFile(join(daemon, "node_modules", "dep", "package.json"), "{\"type\":\"module\",\"main\":\"index.js\"}\n")
    await writeFile(join(daemon, "node_modules", "dep", "index.js"), "export const dependency = \"checked\"\n")
    // The manifest packaging writes (scripts/daemon-runtime.mjs), version 2.
    const files: Record<string, { sha256: string; executable: boolean }> = {}
    const walk = async (directory: string, prefix: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) await walk(join(directory, entry.name), key)
        else files[key] = { sha256: createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex"), executable: false }
      }
    }
    await walk(daemon, "")
    await mkdir(join(appPath, "daemon-runtime-manifests"), { recursive: true })
    await writeFile(join(appPath, "daemon-runtime-manifests", `${process.platform}-${process.arch}.json`), JSON.stringify({ version: 2, files, links: {} }))
    const copyParent = join(root, "tmp")
    await mkdir(copyParent)
    return { root, resourcesPath, appPath, daemon, copyParent, location: { isPackaged: true, resourcesPath, appPath, copyParent } }
  }

  const credentials = () => ({ take: vi.fn(() => ({})), homeDirectory: () => "/Users/dana" })

  it("imports the shipped daemon when its files match the build, then hands over the credentials", async () => {
    const app = await packagedApp()
    const handOff = credentials()
    const loaded = await loadDaemonModule(app.location, undefined, handOff)
    expect(typeof loaded.module.acquireLocalDaemon).toBe("function")
    expect(handOff.take).toHaveBeenCalledOnce()
  })

  // Owner ruling 2026-09-26 (Q39 B): the daemon and its libraries load from a
  // private copy of the bytes the check read, never from the resources.
  it("loads the daemon and its libraries from a private copy of the checked bytes", async () => {
    const app = await packagedApp()
    const loaded = await loadDaemonModule(app.location, undefined, credentials())
    const copies = await readdir(app.copyParent)
    expect(copies).toHaveLength(1)
    expect(loaded.from).toBe(pathToFileURL(join(app.copyParent, copies[0]!, "dist", "public.js")).href)
    expect((loaded.module.acquireLocalDaemon as unknown as () => string)()).toBe("checked")
    expect(await readFile(join(app.copyParent, copies[0]!, "node_modules", "dep", "index.js"), "utf8")).toBe("export const dependency = \"checked\"\n")
  })

  it("refuses a changed library file under node_modules before importing anything or handing anything over", async () => {
    const app = await packagedApp()
    await writeFile(join(app.daemon, "node_modules", "dep", "index.js"), "throw new Error(\"the changed library ran\")\n")
    const handOff = credentials()
    await expect(loadDaemonModule(app.location, undefined, handOff))
      .rejects.toThrow(/node_modules[/\\]dep[/\\]index\.js does not match this build\./)
    expect(handOff.take).not.toHaveBeenCalled()
  })

  it("copies a recorded link as the link it is, and refuses one whose text changed", async () => {
    const app = await packagedApp()
    const manifestPath = join(app.appPath, "daemon-runtime-manifests", `${process.platform}-${process.arch}.json`)
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { links: Record<string, string> }
    manifest.links["node_modules/dep/alias.js"] = "index.js"
    await writeFile(manifestPath, JSON.stringify(manifest))
    await symlink("index.js", join(app.daemon, "node_modules", "dep", "alias.js"))
    await loadDaemonModule(app.location, undefined, credentials())
    const [copy] = await readdir(app.copyParent)
    expect(await (await import("node:fs/promises")).readlink(join(app.copyParent, copy!, "node_modules", "dep", "alias.js"))).toBe("index.js")

    const changed = await packagedApp()
    const changedManifest = join(changed.appPath, "daemon-runtime-manifests", `${process.platform}-${process.arch}.json`)
    const recorded = JSON.parse(await readFile(changedManifest, "utf8")) as { links: Record<string, string> }
    recorded.links["node_modules/dep/alias.js"] = "index.js"
    await writeFile(changedManifest, JSON.stringify(recorded))
    await symlink("../../package.json", join(changed.daemon, "node_modules", "dep", "alias.js"))
    await expect(loadDaemonModule(changed.location, undefined, credentials())).rejects.toThrow(/alias\.js does not match this build\./)
    expect(await readdir(changed.copyParent)).toEqual([])
  })

  it("loads the checked bytes when a file is swapped between the check and the load", async () => {
    const app = await packagedApp()
    const swap = async () => {
      await writeFile(join(app.daemon, "dist", "public.js"), `throw new Error("the swapped file ran")\n${publicModule}`)
      await writeFile(join(app.daemon, "node_modules", "dep", "index.js"), "throw new Error(\"the swapped library ran\")\n")
    }
    const loaded = await loadDaemonModule({ ...app.location, afterCheck: swap }, undefined, credentials())
    expect((loaded.module.acquireLocalDaemon as unknown as () => string)()).toBe("checked")
  })

  it("refuses a changed file before importing it or handing anything over", async () => {
    const app = await packagedApp()
    await writeFile(join(app.daemon, "dist", "public.js"), `throw new Error("the changed file ran")\n${publicModule}`)
    const handOff = credentials()
    await expect(loadDaemonModule(app.location, undefined, handOff))
      .rejects.toThrow(/dist[/\\]public\.js does not match this build\./)
    expect(handOff.take).not.toHaveBeenCalled()
  })

  it("refuses a file this build did not ship", async () => {
    const app = await packagedApp()
    await writeFile(join(app.daemon, "dist", "extra.js"), "export {}\n")
    await expect(loadDaemonModule(app.location, undefined, credentials()))
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
      await expect(loadDaemonModule(app.location, undefined, handOff), part)
        .rejects.toThrow(new RegExp(`${part} leads outside this app's resources\\.`))
      expect(handOff.take, part).not.toHaveBeenCalled()
    }
  })

  it("refuses a manifest that is not a digest manifest", async () => {
    const app = await packagedApp()
    await writeFile(join(app.appPath, "daemon-runtime-manifests", `${process.platform}-${process.arch}.json`), "[]")
    await expect(loadDaemonModule(app.location, undefined, credentials()))
      .rejects.toThrow(/is not a digest manifest\./)
  })

  it("refuses a package with no recorded digests", async () => {
    const app = await packagedApp()
    await rm(join(app.appPath, "daemon-runtime-manifests"), { recursive: true })
    await expect(loadDaemonModule(app.location, undefined, credentials()))
      .rejects.toBeInstanceOf(DaemonRuntimeLoadError)
  })
})
