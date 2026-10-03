import { nodeRuntimeFileSystem, prepareDaemonRuntime } from "@getdomovoi/daemon"
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDesktopDaemonService } from "./daemon-service-assembly.js"
import type { DaemonModule } from "./daemon-module.js"
import type { DesktopDaemon } from "./desktop-daemon.js"

// Security review round 2 of #577 (P1): the service calls act for the profile
// this app's daemon runs. The install writes that profile, and every service
// call gets the app's profile to check again under the service-operation lease.
describe("the login service assembled for this app's profile", () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  async function scratch() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-assembly-")))
    roots.push(root)
    const resourcesPath = join(root, "Resources")
    // The runtime the app ships, in <resources>/daemon-runtime.
    const shipped = daemonRuntimeLayoutUnder(join(resourcesPath, "daemon-runtime"))
    await mkdir(dirname(shipped.nodePath), { recursive: true })
    await mkdir(dirname(shipped.daemonEntryPath), { recursive: true })
    await writeFile(shipped.nodePath, "node")
    await writeFile(shipped.daemonEntryPath, "daemon")
    const home = join(root, "home")
    await mkdir(home)
    // The app's daemon has made its profile directory by the time Settings asks.
    const profile = join(root, "profiles", "work")
    await mkdir(profile, { recursive: true })
    return { resourcesPath, home, profile }
  }

  function daemonModule() {
    const installed = { kind: "file" as const, path: "/p", configurationPath: "/c" }
    return {
      serviceProfileMismatch: vi.fn(() => undefined),
      readLocalServiceHandoffRefusal: vi.fn(async () => undefined),
      holdServiceHandoffFence: vi.fn(async () => ({ release: () => {} })),
      installDaemonService: vi.fn(async (options: { releaseInAppDaemon?: () => Promise<void> }) => { await options.releaseInAppDaemon?.(); return installed }),
      updateDaemonService: vi.fn(async () => installed),
      removeDaemonService: vi.fn(async () => ({ kind: "file" as const, path: "/p", profileRecovery: "not-needed" as const })),
      readDaemonServiceStatus: vi.fn(async () => ({ installed: true, running: true, detail: "" })),
      readDaemonServiceRuntimeCopy: vi.fn(async () => ({ installed: false as const })),
      removeUnusedDaemonRuntimes: vi.fn(async () => ({ removed: [] })),
      // The daemon's own copy routine, run for real against the scratch
      // directories.
      prepareDaemonRuntime,
      nodeRuntimeFileSystem,
    }
  }

  function desktopDaemon(): DesktopDaemon {
    const attached = { kind: "attached" as const, owner: "daemon" as const, url: "ws://127.0.0.1:47831/rpc", token: "t" }
    return {
      current: () => ({ kind: "owned", url: "ws://127.0.0.1:47831/rpc", token: "t" }),
      beginHandoff: () => {},
      endHandoff: () => {},
      stopOwned: async () => {},
      attachOnly: async () => attached,
      restart: async () => attached,
    } as unknown as DesktopDaemon
  }

  it("installs, updates and removes for the profile this app's environment names", async () => {
    const { resourcesPath, home, profile } = await scratch()
    const daemon = daemonModule()
    const service = createDesktopDaemonService(desktopDaemon(), { resourcesPath, version: "0.9.4", home, environment: { DOMOVOI_PROFILE_DIR: profile } }, daemon as unknown as DaemonModule)
    await expect(service.install()).resolves.toMatchObject({ ok: true })
    expect(daemon.serviceProfileMismatch).toHaveBeenCalledWith({ environment: { DOMOVOI_PROFILE_DIR: profile }, homeDirectory: home })
    expect(daemon.installDaemonService).toHaveBeenCalledWith(expect.objectContaining({ environment: { DOMOVOI_PROFILE_DIR: profile } }))
    // Round 3 (P2): the runtime is copied under the app's profile, not the home's.
    // Round 7: into a fresh <version>/<id> directory under the app's profile.
    const installed = (daemon.installDaemonService.mock.calls[0] as unknown as [{ runtime: { nodePath: string; daemonEntryPath: string } }])[0].runtime
    expect(installed).toEqual(daemonRuntimeLayoutUnder(dirname(dirname(dirname(installed.daemonEntryPath)))))
    expect(dirname(dirname(dirname(dirname(installed.daemonEntryPath))))).toBe(join(profile, "runtime", "0.9.4"))
    // Round 4 (P2): the fake service call never published, so nothing is in
    // place. Round 8: not even the runtime directory was made.
    expect(await readdir(profile)).toEqual([])
    await expect(service.update()).resolves.toMatchObject({ ok: true })
    expect(daemon.updateDaemonService).toHaveBeenCalledWith(expect.objectContaining({ environment: { DOMOVOI_PROFILE_DIR: profile } }))
    await expect(service.remove()).resolves.toMatchObject({ ok: true })
    expect(daemon.removeDaemonService).toHaveBeenCalledWith(undefined, { environment: { DOMOVOI_PROFILE_DIR: profile } })
  })

  // #635: the unused copies are looked for under the profile the copy was
  // published to, once the service call published it and the service runs.
  it("removes unused runtime copies under the profile this app's environment names", async () => {
    const { resourcesPath, home, profile } = await scratch()
    const daemon = daemonModule()
    daemon.installDaemonService.mockImplementation(async (options: { releaseInAppDaemon?: () => Promise<void>; staged?: { publish: () => Promise<void> } }) => {
      await options.releaseInAppDaemon?.()
      await options.staged?.publish()
      return { kind: "file" as const, path: "/p", configurationPath: "/c" }
    })
    const service = createDesktopDaemonService(desktopDaemon(), { resourcesPath, version: "0.9.4", home, environment: { DOMOVOI_PROFILE_DIR: profile } }, daemon as unknown as DaemonModule)
    await expect(service.install()).resolves.toMatchObject({ ok: true })
    const installed = (daemon.installDaemonService.mock.calls[0] as unknown as [{ runtime: { nodePath: string; daemonEntryPath: string } }])[0].runtime
    expect(daemon.readDaemonServiceRuntimeCopy).toHaveBeenCalledOnce()
    expect(daemon.removeUnusedDaemonRuntimes).toHaveBeenCalledExactlyOnceWith({ profileDirectory: profile, published: installed, previous: { installed: false } })
    expect(await readdir(join(profile, "runtime", "0.9.4"))).toHaveLength(1)
  })

  it("names no profile for an app on the default one, so the service calls check the default", async () => {
    const { resourcesPath, home } = await scratch()
    const daemon = daemonModule()
    const service = createDesktopDaemonService(desktopDaemon(), { resourcesPath, version: "0.9.4", home, environment: {} }, daemon as unknown as DaemonModule)
    await service.install()
    expect(daemon.installDaemonService).toHaveBeenCalledWith(expect.objectContaining({ environment: {} }))
    const installed = (daemon.installDaemonService.mock.calls[0] as unknown as [{ runtime: { daemonEntryPath: string } }])[0].runtime
    expect(dirname(dirname(dirname(dirname(installed.daemonEntryPath))))).toBe(join(home, ".domovoi", "runtime", "0.9.4"))
  })
})

function daemonRuntimeLayoutUnder(destination: string) {
  return process.platform === "win32"
    ? { nodePath: join(destination, "node", "node.exe"), daemonEntryPath: join(destination, "daemon", "dist", "index.js") }
    : { nodePath: join(destination, "node", "bin", "node"), daemonEntryPath: join(destination, "daemon", "dist", "index.js") }
}
