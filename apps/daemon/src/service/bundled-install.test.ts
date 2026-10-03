import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { parseServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { runServiceCommand, type ServiceCommandDependencies, type ServiceEffects } from "./install.js"
import { daemonRuntimeLayout, nodeRuntimeFileSystem, type RuntimeFileSystem } from "./runtime-stage.js"
import { systemdUnitProgram } from "./units.js"

// Q408 A (2026-10-02): `domovoid service install` run from the runtime the
// Domovoi app ships (its launcher in <resources>/daemon-runtime/bin) copies
// that runtime under the profile first, as the app's Install does, so the
// service never runs from inside the app. Every file here is in a scratch
// directory; the service manager is a mock and nothing is registered.

let root: string
let resources: string
let home: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-bundled-install-")))
  resources = join(root, "Domovoi.app", "Contents", "Resources")
  home = join(root, "home")
  const shipped = daemonRuntimeLayout(resources, "linux")
  await mkdir(dirname(shipped.nodePath), { recursive: true })
  await mkdir(dirname(shipped.daemonEntryPath), { recursive: true })
  await writeFile(shipped.nodePath, "node")
  await writeFile(shipped.daemonEntryPath, "daemon")
  await mkdir(home)
  await mkdir(join(root, "staging"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// A Linux install with lingering already on, so the manager is asked only
// what the mock answers.
function effects(): ServiceEffects {
  return {
    claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
    claimProfile: vi.fn(() => ({ release: vi.fn() })),
    removalSnapshot: vi.fn(() => ({ owner: undefined, configurationDigest: null })),
    writeRemovalReceipt: vi.fn(),
    write: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    capture: vi.fn(async (command: string) => command === "loginctl" ? { code: 0, stdout: "yes\n" } : { code: 0, stdout: "" }),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
  }
}

function command(overrides: Partial<ServiceCommandDependencies> = {}): ServiceCommandDependencies {
  const shipped = daemonRuntimeLayout(resources, "linux")
  return {
    ...effects(),
    platform: "linux",
    execPath: shipped.daemonEntryPath,
    runtime: shipped.nodePath,
    home,
    uid: 1000,
    user: "dana",
    workingDirectory: home,
    environment: {},
    version: "0.9.4",
    runtimeStagingParent: join(root, "staging"),
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  }
}

function written(dependencies: ServiceCommandDependencies, ending: string): string | undefined {
  return vi.mocked(dependencies.write).mock.calls.find(([path]) => path.endsWith(ending))?.[1]
}

describe.skipIf(process.platform === "win32")("domovoid service install from the app's runtime", () => {
  it("copies the runtime under the profile and installs the service from the copy", async () => {
    const dependencies = command()
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
    expect(dependencies.stderr).not.toHaveBeenCalled()
    const versions = join(home, ".domovoi", "runtime", "0.9.4")
    const [copy] = await readdir(versions)
    // <profile>/runtime/<version>/<id>, holding what daemon-runtime holds.
    const runtime = { nodePath: join(versions, copy!, "node", "bin", "node"), daemonEntryPath: join(versions, copy!, "daemon", "dist", "index.js") }
    expect(await readFile(runtime.nodePath, "utf8")).toBe("node")
    expect(await readFile(runtime.daemonEntryPath, "utf8")).toBe("daemon")
    const unit = systemdUnitProgram(written(dependencies, "domovoid.service")!)
    expect(unit).toEqual({ execPath: runtime.nodePath, args: [runtime.daemonEntryPath, "--service-config", join(home, ".domovoi", "service.json")] })
    expect(JSON.parse(written(dependencies, "service.json")!)).toMatchObject({ serviceRuntime: { executable: runtime.nodePath, entry: runtime.daemonEntryPath } })
    for (const [, contents] of vi.mocked(dependencies.write).mock.calls) expect(contents).not.toContain(resources)
    expect(dependencies.stdout).toHaveBeenCalledWith(`Copied the daemon runtime out of the app to ${join(versions, copy!)}, so the service does not run from inside the app.\n`)
    expect(dependencies.stdout).toHaveBeenCalledWith(`Installed the Domovoi daemon service at ${join(home, ".config", "systemd", "user", "domovoid.service")}\n`)
  })

  it("copies under the profile DOMOVOI_PROFILE_DIR names", async () => {
    const profile = join(root, "profiles", "work")
    await mkdir(profile, { recursive: true })
    const dependencies = command({ environment: { DOMOVOI_PROFILE_DIR: profile } })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
    expect(await readdir(join(profile, "runtime", "0.9.4"))).toHaveLength(1)
    expect(await readdir(home)).toEqual([])
  })

  it("installs from where it runs, copying nothing, when run from an installed copy or a checkout", async () => {
    for (const [execPath, runtime] of [
      [join(home, ".domovoi", "runtime", "0.9.3", "0123456789ab", "daemon", "dist", "index.js"), join(home, ".domovoi", "runtime", "0.9.3", "0123456789ab", "node", "bin", "node")],
      [join(root, "domovoi", "apps", "daemon", "dist", "index.js"), "/usr/bin/node"],
    ] as const) {
      const dependencies = command({ execPath, runtime })
      expect(await runServiceCommand(["service", "install"], dependencies), execPath).toBe(0)
      expect(JSON.parse(written(dependencies, "service.json")!)).toMatchObject({ serviceRuntime: { executable: runtime, entry: execPath } })
      expect(dependencies.stdout).not.toHaveBeenCalledWith(expect.stringContaining("Copied"))
    }
    expect(await readdir(home)).toEqual([])
  })

  // An app that will not be at this path once it quits: a service copied
  // from it now would still be named after a mount that goes away, and the
  // in-app Install makes the same copy from a running app.
  //
  // A disk image mounts read only under /Volumes; the file system answers
  // that here, since no real disk image is mounted.
  const diskImage = "/Volumes/Domovoi 0.9.4"
  const volumes = (readOnly: string[]) => nodeRuntimeFileSystem({
    readOnly: async (path) => readOnly.some((volume) => path === volume || path.startsWith(`${volume}/`)),
  })
  it.each([
    ["a disk image", `${diskImage}/Domovoi.app/Contents/Resources`, {},"Domovoi is running from a disk image, so its commands are not where a login service can keep running them. Copy Domovoi to Applications and run this again from there, or use Install under Daemon on this machine in Settings. Nothing was installed."],
    ["macOS App Translocation", "/private/var/folders/x/T/AppTranslocation/1A2B/d/Domovoi.app/Contents/Resources", {}, "macOS is running Domovoi from a temporary copy, so its commands are not where a login service can keep running them. Move Domovoi to Applications and open it once from there, then run this again, or use Install under Daemon on this machine in Settings. Nothing was installed."],
    ["an AppImage mount", "/tmp/.mount_DomovoXyZ12/resources", {}, "Domovoi is running as an AppImage, which mounts at a new path on every launch, so its commands are not where a login service can keep running them. Use Install under Daemon on this machine in Settings, which copies the runtime out of the AppImage. Nothing was installed."],
    ["an AppImage named by APPIMAGE", "/opt/odd/resources", { APPIMAGE: "/home/dana/Domovoi.AppImage" }, "Domovoi is running as an AppImage, which mounts at a new path on every launch, so its commands are not where a login service can keep running them. Use Install under Daemon on this machine in Settings, which copies the runtime out of the AppImage. Nothing was installed."],
  ])("refuses an app running from %s, writing nothing", async (_label, at, environment, reason) => {
    const shipped = daemonRuntimeLayout(at, "linux")
    const dependencies = command({ execPath: shipped.daemonEntryPath, runtime: shipped.nodePath, environment, runtimeFileSystem: volumes([diskImage]) })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith(`${reason}\n`)
    expect(dependencies.write).not.toHaveBeenCalled()
    expect(dependencies.run).not.toHaveBeenCalled()
    expect(dependencies.claimServiceOperation).not.toHaveBeenCalled()
    expect(await readdir(home)).toEqual([])
  })

  // An external drive also mounts under /Volumes, writable, and the app
  // stays there between launches. It is not refused as a disk image: here it
  // goes on to the runtime check, which finds no runtime at this made-up path.
  it("installs from an app on a writable volume under /Volumes", async () => {
    const shipped = daemonRuntimeLayout("/Volumes/External SSD/Applications/Domovoi.app/Contents/Resources", "linux")
    const dependencies = command({ execPath: shipped.daemonEntryPath, runtime: shipped.nodePath, runtimeFileSystem: volumes([diskImage]) })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith(`The Node runtime this app ships was not found at ${shipped.nodePath}. No service was installed and no service files were changed.\n`)
    expect(await readdir(home)).toEqual([])
  })

  it("installs nothing when the app's runtime is missing a part", async () => {
    await rm(daemonRuntimeLayout(resources, "linux").nodePath)
    const dependencies = command()
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith(`The Node runtime this app ships was not found at ${daemonRuntimeLayout(resources, "linux").nodePath}. No service was installed and no service files were changed.\n`)
    expect(dependencies.write).not.toHaveBeenCalled()
    expect(dependencies.run).not.toHaveBeenCalled()
    expect(await readdir(home)).toEqual([])
  })

  // The copy is made under the service-operation lease, after the profile
  // checks: a refused install leaves no copy behind.
  it("copies nothing when the install is refused before its changes", async () => {
    const dependencies = command({ claimServiceOperation: vi.fn(() => { throw new Error("Another service change is in progress.") }) })
    expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
    expect(dependencies.stderr).toHaveBeenCalledWith("Another service change is in progress.\n")
    expect(await readdir(home)).toEqual([])
  })

  // #635 for the command: once its service is installed, the same cleanup the
  // app's Install runs removes the copies no service runs. The copy the
  // service runs now and the one it ran before this install are kept, as the
  // app keeps them (runtime-cleanup.ts).
  it("removes the copies no service runs once a reinstall is installed", async () => {
    // The service manager's files, as the mocked writes leave them.
    const files = new Map<string, string>()
    const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
    const readConfiguration = (at: string, platform: string) => {
      const found = files.get(serviceConfigurationPath(at, platform))
      return found === undefined ? undefined : parseServiceConfiguration(found)
    }
    const install = () => command({
      write: vi.fn(async (path: string, contents: string) => { files.set(path, contents) }),
      exists: vi.fn(async (path: string) => files.has(path)),
      read: vi.fn(async (path: string) => { const found = files.get(path); if (found === undefined) throw missing(path); return found }),
      readConfiguration: vi.fn(readConfiguration),
      // What the cleanup reads the service definition with, here over the
      // same files.
      runtimeReader: {
        platform: "linux", home,
        readDefinition: async (path) => files.get(path),
        capture: vi.fn(async () => ({ code: 0, stdout: "" })),
        readConfiguration,
      },
    })
    const versions = join(home, ".domovoi", "runtime", "0.9.4")
    const copies: string[] = []
    for (let run = 0; run < 3; run += 1) {
      const dependencies = install()
      const code = await runServiceCommand(["service", "install"], dependencies)
      expect(code, `install ${run}: ${vi.mocked(dependencies.stderr).mock.calls.join("")}`).toBe(0)
      copies.push(systemdUnitProgram(files.get(join(home, ".config", "systemd", "user", "domovoid.service"))!)!.args[0]!.split("/").at(-4)!)
    }
    // The first copy is gone; the one the service ran before the last
    // install and the one it runs now stay.
    expect((await readdir(versions)).sort()).toEqual([copies[1]!, copies[2]!].sort())
  })

  // Inside WSL the install registers a Windows task that starts the guest
  // runtime. From the app's runtime it must start the copy too: the app's
  // path goes away once an AppImage unmounts or the app moves.
  describe("inside WSL", () => {
    const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    function inWsl(overrides: Partial<ServiceCommandDependencies> = {}): ServiceCommandDependencies {
      return command({
        environment: { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1_interop" },
        capture: vi.fn(async (_command: string, args: string[]) => ({ code: 0, stdout: args[0] === "-u" ? powershell : "C:\\Windows" })),
        exists: vi.fn(async () => false),
        ...overrides,
      })
    }

    it("copies the runtime under the profile and registers the task against the copy", async () => {
      const dependencies = inWsl()
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
      expect(dependencies.stderr).not.toHaveBeenCalled()
      const versions = join(home, ".domovoi", "runtime", "0.9.4")
      const [copy] = await readdir(versions)
      const runtime = { nodePath: join(versions, copy!, "node", "bin", "node"), daemonEntryPath: join(versions, copy!, "daemon", "dist", "index.js") }
      expect(await readFile(runtime.daemonEntryPath, "utf8")).toBe("daemon")
      const saved = JSON.parse(written(dependencies, "service.json")!)
      expect(saved).toMatchObject({
        wsl: { executable: runtime.nodePath, args: [runtime.daemonEntryPath] },
        serviceRuntime: { executable: runtime.nodePath, entry: runtime.daemonEntryPath },
      })
      for (const [, contents] of vi.mocked(dependencies.write).mock.calls) expect(contents).not.toContain(resources)
      for (const [, args] of vi.mocked(dependencies.run).mock.calls) expect(args.join(" ")).not.toContain(resources)
      expect(dependencies.stdout).toHaveBeenCalledWith(`Copied the daemon runtime out of the app to ${join(versions, copy!)}, so the service does not run from inside the app.\n`)
    })

    it("copies nothing when the WSL install is refused before its changes", async () => {
      const dependencies = inWsl({ exists: vi.fn(async (path: string) => path.endsWith("domovoid.service")) })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      expect(dependencies.stderr).toHaveBeenCalledWith("Remove the existing systemd registration before installing the WSL service\n")
      expect(await readdir(home)).toEqual([])
    })
  })

  // Where /tmp is a tmpfs (Fedora, Arch, Debian 13) and TMPDIR is unset, the
  // system temporary directory is on another volume from the profile, so the
  // copy could not be moved in by one rename. The command then stages under
  // ${XDG_STATE_HOME:-~/.local/state}/domovoi/runtime-staging, as the app's
  // Install stages under its data directory, with the same checks.
  describe("when the system temporary directory is on another volume", () => {
    const identity = nodeRuntimeFileSystem().identity
    const offVolume = (...under: string[]): RuntimeFileSystem => nodeRuntimeFileSystem({
      identity: async (path) => path === tmpdir() || under.some((at) => path === at || path.startsWith(`${at}/`)) ? "other-volume:1" : identity(path),
    })
    // The real staging places, not the scratch one the other tests pass.
    function fromSystemPlaces(overrides: Partial<ServiceCommandDependencies>): ServiceCommandDependencies {
      const dependencies = command(overrides)
      delete dependencies.runtimeStagingParent
      return dependencies
    }
    // Names the directory that failed, and every directory made before it.
    // remedy: what the access gate adds for the directory it named, if any.
    const refusal = (failed: string, made: string[] = [], remedy: { owner?: string; chmod?: string } = {}) => `The runtime could not be copied out of the app: the system temporary directory, ${tmpdir()}, and ${failed} must each be a directory, not a link, that no other account can change, on the same volume as the profile directory ${join(home, ".domovoi")} and outside every profile and repository, and neither is. ${remedy.owner === undefined ? "" : `${remedy.owner} belongs to another account. `}Set TMPDIR or XDG_STATE_HOME to a directory that is, and run this again. ${remedy.chmod === undefined ? "" : `Run chmod go-w ${remedy.chmod} and try again. `}${made.length === 0 ? "Nothing was changed." : `It made ${made.join(", ")}, which hold no files, and changed nothing else.`}\n`

    // PR #712 security review round 2 (P2): a state directory another
    // account could change is refused like one on another volume, named.
    // Q413 A: a directory this user owns that group or others can write gets
    // the chmod that fixes it; one another account owns does not, since
    // that chmod would not work.
    const gated = (state: string, answer: { uid: number; mode: number }) => {
      const real = nodeRuntimeFileSystem()
      return nodeRuntimeFileSystem({
        identity: async (path) => path === tmpdir() ? "other-volume:1" : real.identity(path),
        permissions: async (path) => path === state ? answer : real.permissions(path),
      })
    }
    const me = process.getuid?.() ?? 0

    it.each([
      ["group", 0o40775],
      ["others", 0o40777],
    ])("refuses a state directory this user owns that %s can write, with the chmod that fixes it", async (_label, mode) => {
      const state = join(home, ".local", "state", "domovoi")
      await mkdir(state, { recursive: true })
      const dependencies = fromSystemPlaces({ runtimeFileSystem: gated(state, { uid: me, mode }) })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      expect(dependencies.stderr).toHaveBeenCalledWith(refusal(state, [], { chmod: state }))
      expect(dependencies.write).not.toHaveBeenCalled()
      expect(await readdir(state)).toEqual([])
    })

    it("quotes a directory the chmod names when it holds a space", async () => {
      const stateHome = join(root, "my state")
      const state = join(stateHome, "domovoi")
      await mkdir(state, { recursive: true })
      const dependencies = fromSystemPlaces({ runtimeFileSystem: gated(state, { uid: me, mode: 0o40775 }), environment: { XDG_STATE_HOME: stateHome } })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      expect(dependencies.stderr).toHaveBeenCalledWith(refusal(state, [], { chmod: `'${state}'` }))
    })

    it("says a state directory belongs to another account, with no chmod", async () => {
      const state = join(home, ".local", "state", "domovoi")
      await mkdir(state, { recursive: true })
      const dependencies = fromSystemPlaces({ runtimeFileSystem: gated(state, { uid: me + 1, mode: 0o40755 }) })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      expect(dependencies.stderr).toHaveBeenCalledWith(refusal(state, [], { owner: state }))
      expect(vi.mocked(dependencies.stderr).mock.calls.join("")).not.toContain("chmod")
      expect(dependencies.write).not.toHaveBeenCalled()
    })

    // Linux reports every link as 0777 (macOS uses the umask), so a level
    // swapped for a link looked like this user's own open directory. A chmod
    // there would follow the link, so a non-directory gets no chmod.
    it("gives no chmod for a level that is not a directory, as a link Linux reports 0777", async () => {
      const state = join(home, ".local", "state", "domovoi")
      await mkdir(state, { recursive: true })
      const dependencies = fromSystemPlaces({ runtimeFileSystem: gated(state, { uid: me, mode: 0o120777 }) })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      expect(dependencies.stderr).toHaveBeenCalledWith(refusal(state))
      expect(dependencies.write).not.toHaveBeenCalled()
    })

    it("stages under ~/.local/state/domovoi, making only the directories it needs", async () => {
      const dependencies = fromSystemPlaces({ runtimeFileSystem: offVolume() })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(0)
      expect(dependencies.stderr).not.toHaveBeenCalled()
      const versions = join(home, ".domovoi", "runtime", "0.9.4")
      const [copy] = await readdir(versions)
      expect(await readFile(join(versions, copy!, "daemon", "dist", "index.js"), "utf8")).toBe("daemon")
      expect(JSON.parse(written(dependencies, "service.json")!)).toMatchObject({ serviceRuntime: { entry: join(versions, copy!, "daemon", "dist", "index.js") } })
      expect((await readdir(home)).sort()).toEqual([".domovoi", ".local"])
      expect(await readdir(join(home, ".local"))).toEqual(["state"])
      expect(await readdir(join(home, ".local", "state"))).toEqual(["domovoi"])
      expect(await readdir(join(home, ".local", "state", "domovoi"))).toEqual(["runtime-staging"])
      // The private staging directory stays, empty, by design.
      const [holder, ...more] = await readdir(join(home, ".local", "state", "domovoi", "runtime-staging"))
      expect(more).toEqual([])
      expect(holder!.startsWith(".domovoi-runtime-0.9.4.staging-")).toBe(true)
      expect(await readdir(join(home, ".local", "state", "domovoi", "runtime-staging", holder!))).toEqual([])
    })

    it("stages under an absolute XDG_STATE_HOME and ignores a relative one", async () => {
      const state = join(root, "state")
      await mkdir(state)
      const absolute = fromSystemPlaces({ runtimeFileSystem: offVolume(), environment: { XDG_STATE_HOME: state } })
      expect(await runServiceCommand(["service", "install"], absolute)).toBe(0)
      expect(await readdir(join(state, "domovoi", "runtime-staging"))).toHaveLength(1)
      expect(await readdir(home)).toEqual([".domovoi"])

      const relative = fromSystemPlaces({ runtimeFileSystem: offVolume(), environment: { XDG_STATE_HOME: "relative-state" } })
      expect(await runServiceCommand(["service", "install"], relative)).toBe(0)
      expect(await readdir(join(home, ".local", "state", "domovoi", "runtime-staging"))).toHaveLength(1)
      expect(await readdir(join(state, "domovoi", "runtime-staging"))).toHaveLength(1)
    })

    it("refuses with the command's words, writing nothing, when the state directory is on another volume too", async () => {
      await mkdir(join(home, ".local", "state"), { recursive: true })
      const dependencies = fromSystemPlaces({ runtimeFileSystem: offVolume(join(home, ".local")) })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      // ~/.local/state is the directory there that is on the other volume.
      expect(dependencies.stderr).toHaveBeenCalledWith(refusal(join(home, ".local", "state")))
      expect(vi.mocked(dependencies.stderr).mock.calls.join("")).not.toContain("this app's")
      expect(dependencies.write).not.toHaveBeenCalled()
      expect(dependencies.claimServiceOperation).not.toHaveBeenCalled()
      expect(await readdir(home)).toEqual([".local"])
      expect(await readdir(join(home, ".local", "state"))).toEqual([])
    })

    // The same checks as the app's data directory: never inside a profile
    // or a repository, even one that is not there yet.
    it.each([
      // A home kept as a repository, as some dotfiles setups do.
      // The home directory is the one that fails: it is the repository.
      ["inside a repository", async () => { await mkdir(join(home, ".git")) }, () => ({}), () => home, [".git"]],
      // ~/.domovoi is not there yet, so this is about the path alone.
      ["inside a profile", async () => {}, () => ({ XDG_STATE_HOME: join(home, ".domovoi", "state") }), () => join(home, ".domovoi", "state", "domovoi"), []],
    ] as const)("refuses a state directory %s, writing nothing", async (_label, arrange, environment, state, left) => {
      await arrange()
      const dependencies = fromSystemPlaces({ runtimeFileSystem: offVolume(), environment: environment() })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      expect(dependencies.stderr).toHaveBeenCalledWith(refusal(state()))
      expect(dependencies.write).not.toHaveBeenCalled()
      expect(await readdir(home)).toEqual(left)
    })

    it("names runtime-staging, not the state directory, when that is what cannot be used", async () => {
      const state = join(home, ".local", "state", "domovoi")
      await mkdir(state, { recursive: true })
      await writeFile(join(state, "runtime-staging"), "not a directory")
      const dependencies = fromSystemPlaces({ runtimeFileSystem: offVolume() })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      expect(dependencies.stderr).toHaveBeenCalledWith(refusal(join(state, "runtime-staging")))
      expect(dependencies.write).not.toHaveBeenCalled()
      expect(await readdir(home)).toEqual([".local"])
    })

    // A directory made at publish that turns out to be unusable: what was
    // made stays, and the refusal says so instead of "Nothing was changed".
    it("lists the directories it made when a level it made cannot be used", async () => {
      const staging = join(home, ".local", "state", "domovoi", "runtime-staging")
      const dependencies = fromSystemPlaces({ runtimeFileSystem: offVolume(staging) })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      expect(dependencies.stderr).toHaveBeenCalledWith(refusal(staging, [
        join(home, ".local"), join(home, ".local", "state"), join(home, ".local", "state", "domovoi"), staging,
      ]))
      expect(dependencies.write).not.toHaveBeenCalled()
      expect(await readdir(staging)).toEqual([])
      expect(await readdir(home)).toEqual([".local"])
    })

    // A level made at publish swapped for a link before the next level is
    // made: the next mkdir would land inside the link's target, here a
    // repository. The level is checked to still be the directory made, so
    // nothing is made there. The instant between that check and the mkdir is
    // the residual race round 8 of #577 accepted for the staging directory.
    it("makes nothing inside a link swapped in for a level it made", async () => {
      const repository = join(root, "repository")
      await mkdir(join(repository, ".git"), { recursive: true })
      const local = join(home, ".local")
      const real = offVolume()
      let made = false
      let swapped = false
      const fileSystem: RuntimeFileSystem = {
        ...real,
        makeDirectory: async (path) => {
          await real.makeDirectory(path)
          if (path === local) made = true
        },
        // Once usable() has passed ~/.local: the last thing it reads is the
        // file-system root's profile-lease.sqlite, at the top of its walk
        // up from ~/.local for repository and profile markers.
        entry: async (path) => {
          const found = await real.entry(path)
          if (made && !swapped && path === join("/", "profile-lease.sqlite")) {
            swapped = true
            await rename(local, join(root, "moved-local"))
            await symlink(repository, local)
          }
          return found
        },
      }
      const dependencies = fromSystemPlaces({ runtimeFileSystem: fileSystem })
      expect(await runServiceCommand(["service", "install"], dependencies)).toBe(1)
      expect(swapped).toBe(true)
      expect(await readdir(repository)).toEqual([".git"])
      expect(dependencies.stderr).toHaveBeenCalledWith(refusal(local, [local]))
      expect(await readdir(join(root, "moved-local"))).toEqual([])
      expect(dependencies.write).not.toHaveBeenCalled()
    })
  })
})
