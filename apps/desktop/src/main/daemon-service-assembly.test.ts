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

  // Review of 049b1383 (P2-3): with the tailnet switch on, a login service
  // installed afterwards keeps the tailnet listener the in-app daemon had.
  it("installs the service with the tailnet listener the switch saved", async () => {
    const { resourcesPath, home, profile } = await scratch()
    const dataDirectory = join(home, "app-data")
    await mkdir(dataDirectory)
    const name = "studio.tail4c2e.ts.net"
    const tls = join(profile, "tls")
    await writeFile(join(dataDirectory, "tailnet-reach.json"), JSON.stringify({ version: 1, name, address: "100.101.102.103", certPath: join(tls, `${name}.crt`), keyPath: join(tls, `${name}.key`), certIdentity: "1:2:946684800000", keyIdentity: "1:3:946684800000" }))
    const daemon = daemonModule()
    // A hand-set DOMOVOI_HOST belongs to this app's own daemon, not the service.
    const service = createDesktopDaemonService(desktopDaemon(), { resourcesPath, version: "0.9.4", home, dataDirectory, environment: { DOMOVOI_PROFILE_DIR: profile, DOMOVOI_HOST: "0.0.0.0" } }, daemon as unknown as DaemonModule)
    await expect(service.install()).resolves.toMatchObject({ ok: true })
    expect(daemon.installDaemonService).toHaveBeenCalledWith(expect.objectContaining({ environment: {
      DOMOVOI_PROFILE_DIR: profile,
      DOMOVOI_ALLOW_REMOTE_TRANSPORT: "1",
      DOMOVOI_TAILNET_ADDRESS: "100.101.102.103",
      DOMOVOI_TAILNET_TLS_CERT_PATH: join(tls, `${name}.crt`),
      DOMOVOI_TAILNET_TLS_KEY_PATH: join(tls, `${name}.key`),
      DOMOVOI_TAILNET_HOST: name,
    } }))
  })

  it("installs the service on loopback alone when the switch is off", async () => {
    const { resourcesPath, home, profile } = await scratch()
    const dataDirectory = join(home, "app-data")
    await mkdir(dataDirectory)
    const daemon = daemonModule()
    const service = createDesktopDaemonService(desktopDaemon(), { resourcesPath, version: "0.9.4", home, dataDirectory, environment: { DOMOVOI_PROFILE_DIR: profile } }, daemon as unknown as DaemonModule)
    await expect(service.install()).resolves.toMatchObject({ ok: true })
    expect(daemon.installDaemonService).toHaveBeenCalledWith(expect.objectContaining({ environment: { DOMOVOI_PROFILE_DIR: profile } }))
  })

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

  // T24: the unpackaged launch smokes turn the login-service calls off. Each
  // one takes the service-operation lease under the account's passwd home,
  // which the smoke's HOME cannot move, so a status read alone wrote the real
  // ~/.domovoi. Off, no call reaches the daemon module.
  it("answers every service call without the daemon when the login service is off", async () => {
    const { resourcesPath, home, profile } = await scratch()
    const daemon = daemonModule()
    const service = createDesktopDaemonService(desktopDaemon(), { resourcesPath, version: "0.9.4", home, environment: { DOMOVOI_PROFILE_DIR: profile }, loginService: "off" }, daemon as unknown as DaemonModule)
    const off = "Login service calls are turned off for this test run."
    await expect(service.status()).resolves.toEqual({ unavailable: off })
    for (const outcome of [await service.install(), await service.update(), await service.remove()]) {
      expect(outcome).toEqual({ ok: false, reason: "check-failed", message: off })
    }
    for (const call of [daemon.readDaemonServiceStatus, daemon.serviceProfileMismatch, daemon.installDaemonService, daemon.updateDaemonService,
      daemon.removeDaemonService, daemon.readDaemonServiceRuntimeCopy, daemon.removeUnusedDaemonRuntimes, daemon.holdServiceHandoffFence]) {
      expect(call).not.toHaveBeenCalled()
    }
    expect(await readdir(profile)).toEqual([])
  })
})

function daemonRuntimeLayoutUnder(destination: string) {
  return process.platform === "win32"
    ? { nodePath: join(destination, "node", "node.exe"), daemonEntryPath: join(destination, "daemon", "dist", "index.js") }
    : { nodePath: join(destination, "node", "bin", "node"), daemonEntryPath: join(destination, "daemon", "dist", "index.js") }
}
