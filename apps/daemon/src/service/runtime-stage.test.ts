import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it, vi } from "vitest"

import { DaemonRuntimeStagingRefusedError, daemonRuntimeLayout, nodeRuntimeFileSystem, parseAccessControlListing, prepareDaemonRuntime, profileRuntimeDirectory, stageDaemonRuntime, unprotectedStagingDirectory, type AccessControlEntry, type RuntimeFileSystem } from "./runtime-stage.js"

const run = promisify(execFile)

// Moved from the desktop (apps/desktop/src/main/daemon-service.test.ts) with
// the copy routine itself (Q408 A), unchanged.

describe("daemon runtime layout", () => {
  it("names the shipped runtime under the app's resources and its copy under the profile", () => {
    expect(daemonRuntimeLayout("/Applications/Domovoi.app/Contents/Resources", "darwin")).toEqual({
      nodePath: "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/node/bin/node",
      daemonEntryPath: "/Applications/Domovoi.app/Contents/Resources/daemon-runtime/daemon/dist/index.js",
    })
    expect(daemonRuntimeLayout("C:\\Program Files\\Domovoi\\resources", "win32")).toEqual({
      nodePath: "C:\\Program Files\\Domovoi\\resources\\daemon-runtime\\node\\node.exe",
      daemonEntryPath: "C:\\Program Files\\Domovoi\\resources\\daemon-runtime\\daemon\\dist\\index.js",
    })
    expect(profileRuntimeDirectory("/Users/dana/.domovoi", "0.9.4", "darwin")).toBe("/Users/dana/.domovoi/runtime/0.9.4")
  })
})

describe("staging the shipped runtime under the profile", () => {
  it("copies node and the daemon from the app's resources and names the copy", async () => {
    await withScratch(async ({ resources, home }) => {
      const renamed: [string, string][] = []
      const runtime = await stage({ resources, home, version: "0.9.4", rename: async (from, to) => { renamed.push([from, to]); await rename(from, to) } })
      // Round 5 (P2): the copy comes from a private staging directory outside
      // every profile, moved in by one rename. Round 7: into a fresh
      // <version>/<id> directory.
      expect(renamed).toEqual([[expect.stringMatching(/[\\/]\.domovoi-runtime-0\.9\.4\.staging-[^\\/]+[\\/]copy$/u), expect.any(String)]])
      const destination = renamed[0]![1]
      expect(dirname(destination)).toBe(join(home, ".domovoi", "runtime", "0.9.4"))
      expect(basename(destination)).toMatch(/^[0-9a-f]{12}$/u)
      expect(renamed[0]![0].startsWith(home)).toBe(false)
      expect(runtime).toEqual(daemonRuntimeLayoutUnder(destination))
      expect(await readFile(runtime.daemonEntryPath, "utf8")).toBe("daemon")
      expect(await readFile(runtime.nodePath, "utf8")).toBe("node")
    })
  })

  it("refuses a version that is not one directory name, and replaces nothing outside the runtime directory", async () => {
    await withScratch(async ({ resources, home, root }) => {
      const victim = join(root, "victim")
      await mkdir(victim, { recursive: true })
      await writeFile(join(victim, "keep.txt"), "keep")
      for (const version of ["../../../victim", "..", "0.9.4/../../x", "0.9.4\\..\\x", ""]) {
        await expect(stage({ resources, home, version })).rejects.toThrow()
      }
      expect(await readdir(victim)).toEqual(["keep.txt"])
      expect(() => profileRuntimeDirectory(home, "../victim", "darwin")).toThrow()
    })
  })

  it("refuses a runtime directory reached through a link, and changes nothing where the link points", async () => {
    await withScratch(async ({ resources, home, root }) => {
      const elsewhere = join(root, "elsewhere")
      await mkdir(join(elsewhere, "0.9.4"), { recursive: true })
      await writeFile(join(elsewhere, "0.9.4", "keep.txt"), "keep")
      await mkdir(join(home, ".domovoi"), { recursive: true })
      await symlink(elsewhere, join(home, ".domovoi", "runtime"), directoryLink)
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toThrow()
      expect(await readdir(elsewhere)).toEqual(["0.9.4"])
      expect(await readdir(join(elsewhere, "0.9.4"))).toEqual(["keep.txt"])
    })
    await withScratch(async ({ resources, home, root }) => {
      const elsewhere = join(root, "elsewhere")
      await mkdir(join(elsewhere, "runtime", "0.9.4"), { recursive: true })
      await writeFile(join(elsewhere, "runtime", "0.9.4", "keep.txt"), "keep")
      await symlink(elsewhere, join(home, ".domovoi"), directoryLink)
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toThrow()
      expect(await readdir(join(elsewhere, "runtime", "0.9.4"))).toEqual(["keep.txt"])
    })
  })

  // Security review round 1 of #635 (P2): lstat of "linked/" or "linked/."
  // looks through the link, so the profile spelled that way passed as a real
  // directory. "linked/x/.." is the link too, once the runtime directory is
  // built from it.
  it.each(["", sep, `${sep}.`, `${sep}x${sep}..`])("refuses a linked profile spelled with %j after it, and publishes nothing where the link points", async (suffix) => {
    await withScratch(async ({ resources, root }) => {
      const actual = join(root, "actual")
      await mkdir(join(actual, "runtime", "0.9.4"), { recursive: true })
      await writeFile(join(actual, "runtime", "0.9.4", "keep.txt"), "keep")
      await mkdir(join(actual, "x"))
      const link = join(root, "linked")
      await symlink(actual, link, directoryLink)
      await expect(stageDaemonRuntime({
        resourcesPath: resources, profileDirectory: link + suffix, version: "0.9.4", platform,
        stagingParent: join(root, "staging"), fileSystem: nodeRuntimeFileSystem(),
      })).rejects.toThrow(`${link} is not a directory (it may be a link), so no runtime was copied under it.`)
      expect(await entries(join(actual, "runtime"))).toEqual(["0.9.4"])
      expect(await entries(join(actual, "runtime", "0.9.4"))).toEqual(["keep.txt"])
    })
  })

  it("requires each shipped part to be a regular file and refuses a link that leaves the shipped runtime, before copying", async () => {
    await withScratch(async ({ resources, home }) => {
      const nodePath = daemonRuntimeLayout(resources, platform).nodePath
      await rm(nodePath)
      await mkdir(nodePath)
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toMatchObject({ name: "DaemonServiceRuntimeMissingError", part: "node" })
      expect(await entries(home)).toEqual([])
    })
    await withScratch(async ({ resources, home, root }) => {
      await writeFile(join(root, "outside.js"), "outside")
      await rm(join(resources, "daemon-runtime", "daemon", "dist", "index.js"))
      await symlink(join(root, "outside.js"), join(resources, "daemon-runtime", "daemon", "dist", "index.js"))
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toMatchObject({ name: "DaemonServiceRuntimeMissingError", part: "daemon" })
      expect(await entries(home)).toEqual([])
    })
    await withScratch(async ({ resources, home, root }) => {
      await mkdir(join(root, "outside"))
      await symlink(join(root, "outside"), join(resources, "daemon-runtime", "node", "lib"), directoryLink)
      await expect(stage({ resources, home, version: "0.9.4" })).rejects.toThrow()
      expect(await entries(home)).toEqual([])
    })
    await withScratch(async ({ resources, home }) => {
      // A link that stays inside the shipped runtime, as npm's bin links do,
      // is kept as a link in the copy.
      await symlink("../daemon/dist/index.js", join(resources, "daemon-runtime", "node", "daemon-entry"), "file")
      const runtime = await stage({ resources, home, version: "0.9.4" })
      expect(dirname(copyOf(runtime))).toBe(join(home, ".domovoi", "runtime", "0.9.4"))
      expect(runtime).toEqual(daemonRuntimeLayoutUnder(copyOf(runtime)))
      // The link text is kept as the platform wrote it: Windows stores the
      // relative target with its own separators.
      expect(await readlink(join(copyOf(runtime), "node", "daemon-entry"))).toBe(join("..", "daemon", "dist", "index.js"))
    })
  })

  it("keeps the earlier copy of the same version when publishing the new one fails", async () => {
    await withScratch(async ({ resources, home }) => {
      const earlier = join(home, ".domovoi", "runtime", "0.9.4")
      await mkdir(join(earlier, "daemon", "dist"), { recursive: true })
      await writeFile(join(earlier, "daemon", "dist", "index.js"), "earlier")
      await expect(stage({ resources, home, version: "0.9.4", rename: async (from, to) => {
        if (from.includes(".staging-")) throw new Error("rename failed")
        await rename(from, to)
      } })).rejects.toThrow("rename failed")
      expect(await readFile(join(earlier, "daemon", "dist", "index.js"), "utf8")).toBe("earlier")
      expect(await readdir(join(home, ".domovoi", "runtime"))).toEqual(["0.9.4"])
    })
  })

  // Security review round 7 of #577: each publish writes a fresh directory,
  // <profile>/runtime/<version>/<id>, that nothing else ever uses. A failure
  // after it leaves every earlier copy as it was, so there is no shared state
  // to put back, and a late or concurrent publish cannot replace another.
  describe("a fresh directory per publish (round 7)", () => {
    const input = (resources: string, home: string, extra: Partial<Parameters<typeof prepareDaemonRuntime>[0]> = {}) => ({
      resourcesPath: resources, profileDirectory: join(home, ".domovoi"), version: "0.9.4", platform,
      stagingParent: join(dirname(home), "staging"), fileSystem: nodeRuntimeFileSystem(), ...extra,
    })

    it("publishes into a fresh directory each time, and never moves or replaces an earlier copy", async () => {
      await withScratch(async ({ resources, home }) => {
        const version = join(home, ".domovoi", "runtime", "0.9.4")
        await mkdir(join(version, "daemon", "dist"), { recursive: true })
        await writeFile(join(version, "daemon", "dist", "index.js"), "earlier")
        const first = await prepareDaemonRuntime(input(resources, home))
        const second = await prepareDaemonRuntime(input(resources, home))
        await first.publish()
        await second.publish()
        expect(first.runtime.daemonEntryPath).not.toBe(second.runtime.daemonEntryPath)
        for (const runtime of [first.runtime, second.runtime]) {
          expect(dirname(dirname(dirname(runtime.daemonEntryPath))).startsWith(`${version}${sep}`)).toBe(true)
          expect(await readFile(runtime.daemonEntryPath, "utf8")).toBe("daemon")
        }
        expect(await readFile(join(version, "daemon", "dist", "index.js"), "utf8")).toBe("earlier")
        // Round 8: each publish leaves its staging directory, empty.
        expect(await leftStaging(join(dirname(home), "staging"))).toEqual([[], []])
      })
    })

    // Round 8 (P2): not even the profile or its runtime directory is made
    // before publish, which the service calls run under their lease.
    it("writes nothing until publish, not even the profile or runtime directory, so a refused change leaves nothing behind", async () => {
      await withScratch(async ({ resources, home }) => {
        const prepared = await prepareDaemonRuntime(input(resources, home))
        expect(await readdir(join(dirname(home), "staging"))).toEqual([])
        expect(await entries(home)).toEqual([])
        expect(prepared.staged).toEqual(daemonRuntimeLayout(resources, platform))
        await prepared.publish()
        expect(dirname(copyOf(prepared.runtime))).toBe(join(home, ".domovoi", "runtime", "0.9.4"))
        expect(await readFile(prepared.runtime.daemonEntryPath, "utf8")).toBe("daemon")
      })
    })

    it("refuses a staging directory inside the profile or inside a repository, writing nothing", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const words = `The profile directory ${join(home, ".domovoi")} is on a different volume from this app's temporary and data directories, so the runtime could not be copied without writing inside a profile. Nothing was changed.`
        const inProfile = join(home, ".domovoi", "scratch")
        await mkdir(inProfile, { recursive: true })
        const inRepository = join(root, "repository", "scratch")
        await mkdir(join(root, "repository", ".git"), { recursive: true })
        await mkdir(inRepository)
        for (const stagingParent of [inProfile, inRepository]) {
          const refused = prepareDaemonRuntime(input(resources, home, { stagingParent })).then((prepared) => prepared.publish())
          await expect(refused, stagingParent).rejects.toThrow(words)
          expect(await readdir(stagingParent), stagingParent).toEqual([])
        }
      })
    })

    // Round 8 (P2): not only the selected profile. A profile any daemon has
    // claimed holds profile-lease.sqlite, which is never removed; a default
    // profile is named .domovoi.
    it("refuses a staging directory inside any other profile, writing nothing", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const words = `The profile directory ${join(home, ".domovoi")} is on a different volume from this app's temporary and data directories, so the runtime could not be copied without writing inside a profile. Nothing was changed.`
        const claimed = join(root, "profiles", "other")
        await mkdir(join(claimed, "scratch"), { recursive: true })
        await writeFile(join(claimed, "profile-lease.sqlite"), "")
        const defaultNamed = join(root, "another-home", ".domovoi", "scratch")
        await mkdir(defaultNamed, { recursive: true })
        for (const stagingParent of [join(claimed, "scratch"), defaultNamed]) {
          const refused = prepareDaemonRuntime(input(resources, home, { stagingParent })).then((prepared) => prepared.publish())
          await expect(refused, stagingParent).rejects.toThrow(words)
          expect(await readdir(stagingParent), stagingParent).toEqual([])
        }
        expect(await entries(home)).toEqual([])
      })
    })

    // Round 9 (P2): on a case-insensitive volume .DOMOVOI is the same
    // directory as .domovoi, so the name is compared case-folded everywhere.
    it("refuses a staging directory under a default-named profile whose name differs only in case", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const upper = join(root, "another-home", ".DOMOVOI", "scratch")
        await mkdir(upper, { recursive: true })
        const refused = prepareDaemonRuntime(input(resources, home, { stagingParent: upper })).then((prepared) => prepared.publish())
        await expect(refused).rejects.toThrow(`The profile directory ${join(home, ".domovoi")} is on a different volume from this app's temporary and data directories, so the runtime could not be copied without writing inside a profile. Nothing was changed.`)
        expect(await readdir(upper)).toEqual([])
        expect(await entries(home)).toEqual([])
      })
    })

    // Round 8 (P2): checking that the staging directory is still the one made
    // for the copy cannot be bound to removing it by path, so it is never
    // removed. An empty directory swapped in right after such a check stays.
    it("never removes the staging directory, so an empty directory swapped into its place is left", async () => {
      await withScratch(async ({ resources, home }) => {
        const real = nodeRuntimeFileSystem()
        let holder: string | undefined
        const fileSystem = nodeRuntimeFileSystem({
          rename: async (from, to) => { await real.rename(from, to); if (from.includes(".domovoi-runtime-")) holder = dirname(from) },
          identity: async (path) => {
            const found = await real.identity(path)
            // Where a swap would land: after the identity is read.
            if (path === holder) {
              await rename(path, `${path}-moved`)
              await mkdir(path)
            }
            return found
          },
        })
        const prepared = await prepareDaemonRuntime(input(resources, home, { fileSystem }))
        await prepared.publish()
        expect(await readdir(holder!)).toEqual([])
      })
    })
  })

  it("names the missing shipped part before copying anything", async () => {
    await withScratch(async ({ resources, home }) => {
      const nodePath = daemonRuntimeLayout(resources, platform).nodePath
      await rm(nodePath)
      const copy = vi.fn(async () => {})
      await expect(stage({ resources, home, version: "0.9.4", copy })).rejects.toMatchObject({ name: "DaemonServiceRuntimeMissingError", part: "node", path: nodePath })
      expect(copy).not.toHaveBeenCalled()
    })
  })

  // Security review round 3 of #577 (P2): staging runs before the service
  // calls bind the profile under the lease, so it copies only into the
  // selected profile's own runtime directory. A refused change never replaces
  // the copy another profile's service runs.
  it("stages under the selected profile, and leaves another profile's copy of the same version alone", async () => {
    await withScratch(async ({ root, resources, home }) => {
      const other = join(home, ".domovoi", "runtime", "0.9.4")
      await mkdir(join(other, "daemon", "dist"), { recursive: true })
      await writeFile(join(other, "daemon", "dist", "index.js"), "the other profile's copy")
      const profile = join(root, "profiles", "work")
      await mkdir(profile, { recursive: true })
      const runtime = await stageDaemonRuntime({ resourcesPath: resources, profileDirectory: profile, version: "0.9.4", platform, stagingParent: join(root, "staging"), fileSystem: nodeRuntimeFileSystem() })
      expect(dirname(copyOf(runtime))).toBe(join(profile, "runtime", "0.9.4"))
      expect(await readFile(runtime.daemonEntryPath, "utf8")).toBe("daemon")
      expect(await readFile(join(other, "daemon", "dist", "index.js"), "utf8")).toBe("the other profile's copy")
    })
  })

  it("refuses a relative profile directory before copying anything", async () => {
    await withScratch(async ({ resources, home }) => {
      await expect(stageDaemonRuntime({ resourcesPath: resources, home, profileDirectory: "profiles/work", version: "0.9.4", platform, fileSystem: nodeRuntimeFileSystem() } as Parameters<typeof stageDaemonRuntime>[0]))
        .rejects.toThrow("The profile directory profiles/work is not an absolute path, so no runtime was copied.")
      expect(await entries(home)).toEqual([])
    })
  })

  // Round 6 (P2): the private staging directory is removed only while it is
  // still the directory made for this copy. One put in its place is left.
  it("leaves a directory put in the staging directory's place", async () => {
    await withScratch(async ({ resources, home }) => {
      const copy = async (_from: string, to: string) => {
        const holder = dirname(to)
        await rename(holder, `${holder}-moved`)
        await mkdir(holder)
        await writeFile(join(holder, "keep.txt"), "keep")
        throw new Error("copy failed")
      }
      await expect(prepareDaemonRuntime({ resourcesPath: resources, profileDirectory: join(home, ".domovoi"), version: "0.9.4", platform, stagingParent: join(dirname(home), "staging"), fileSystem: nodeRuntimeFileSystem({ copy }) }).then((prepared) => prepared.publish()))
        .rejects.toThrow("copy failed")
      const [holder] = (await readdir(join(dirname(home), "staging"))).filter((name) => !name.endsWith("-moved"))
      expect(await readFile(join(dirname(home), "staging", holder!, "keep.txt"), "utf8")).toBe("keep")
    })
  })

  // Round 6 (P2): when the system temporary directory is on another volume,
  // staging goes under the app's data directory, and only when that is on the
  // runtime's volume, a real directory and outside any repository. Otherwise
  // nothing is written. Copy approved by fetzy on 2026-09-26.
  describe("when the system temporary directory is on another volume", () => {
    const otherVolume = (): Partial<RuntimeFileSystem> => {
      const identity = nodeRuntimeFileSystem().identity
      return { identity: async (path) => path === tmpdir() ? "other-volume:1" : identity(path) }
    }

    it("stages under the app's data directory", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const dataDirectory = join(root, "data")
        await mkdir(dataDirectory)
        const made: string[] = []
        const real = nodeRuntimeFileSystem()
        const fileSystem = nodeRuntimeFileSystem({ ...otherVolume(), makePrivateDirectory: async (prefix) => { made.push(prefix); return real.makePrivateDirectory(prefix) } })
        const prepared = await prepareDaemonRuntime({ resourcesPath: resources, profileDirectory: join(home, ".domovoi"), version: "0.9.4", platform, dataDirectory, fileSystem })
        // Round 8 (P2): preparing makes neither the staging directory nor
        // the profile's.
        expect(await readdir(dataDirectory)).toEqual([])
        expect(await entries(home)).toEqual([])
        await prepared.publish()
        expect(made).toHaveLength(1)
        expect(made[0]!.startsWith(join(dataDirectory, "runtime-staging"))).toBe(true)
        expect(await readFile(prepared.runtime.daemonEntryPath, "utf8")).toBe("daemon")
        expect(await leftStaging(join(dataDirectory, "runtime-staging"))).toEqual([[]])
      })
    })

    it("refuses, writing nothing, when the data directory is inside a repository or on another volume too", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const inRepository = join(root, "repository", "data")
        await mkdir(join(root, "repository", ".git"), { recursive: true })
        await mkdir(inRepository)
        const identity = nodeRuntimeFileSystem().identity
        for (const [label, dataDirectory, fileSystem] of [
          ["inside a repository", inRepository, nodeRuntimeFileSystem(otherVolume())],
          ["on another volume", join(root, "far"), nodeRuntimeFileSystem({ identity: async (path) => path === tmpdir() || path.startsWith(join(root, "far")) ? "other-volume:1" : identity(path) })],
        ] as const) {
          await mkdir(join(root, "far"), { recursive: true })
          await expect(prepareDaemonRuntime({ resourcesPath: resources, profileDirectory: join(home, ".domovoi"), version: "0.9.4", platform, dataDirectory, fileSystem } as Parameters<typeof prepareDaemonRuntime>[0]), label)
            .rejects.toThrow(`The profile directory ${join(home, ".domovoi")} is on a different volume from this app's temporary and data directories, so the runtime could not be copied without writing inside a profile. Nothing was changed.`)
          expect(await entries(home), label).toEqual([])
        }
        expect(await readdir(inRepository)).toEqual([])
      })
    })
  })

  // Round 5 (P2): the copy is made in a private directory outside every
  // profile, so a swap cannot redirect it; nothing is written under the
  // swapped-in path, not even a hidden staging directory.
  it("refuses to publish when the runtime directory is swapped for a link during the copy", async () => {
    await withScratch(async ({ root, resources, home }) => {
      const profile = join(root, "profiles", "work")
      const otherRuntime = join(root, "profiles", "other", "runtime")
      await mkdir(profile, { recursive: true })
      await mkdir(join(otherRuntime, "0.9.4", "daemon", "dist"), { recursive: true })
      await writeFile(join(otherRuntime, "0.9.4", "daemon", "dist", "index.js"), "the other profile's copy")
      const copy = async (from: string, to: string) => {
        await rename(join(profile, "runtime"), join(profile, "runtime-moved"))
        await symlink(otherRuntime, join(profile, "runtime"), directoryLink)
        await nodeRuntimeFileSystem().copy(from, to)
      }
      await expect(stageDaemonRuntime({ resourcesPath: resources, profileDirectory: profile, version: "0.9.4", platform, stagingParent: join(root, "staging"), fileSystem: nodeRuntimeFileSystem({ copy }) }))
        .rejects.toThrow(`${join(profile, "runtime")} changed while the runtime was copied, so it was not published.`)
      expect(await readFile(join(otherRuntime, "0.9.4", "daemon", "dist", "index.js"), "utf8")).toBe("the other profile's copy")
      expect(await readdir(otherRuntime)).toEqual(["0.9.4"])
      expect(await readdir(join(otherRuntime, "0.9.4"))).toEqual(["daemon"])
      // Round 7 (P2): the unpublished copy stays in its private staging
      // directory, outside every profile: whether that path is still the
      // directory made for it cannot be known when it is removed.
      expect((await readdir(join(root, "staging"))).every((name) => name.startsWith(".domovoi-runtime-0.9.4.staging-"))).toBe(true)
      expect(await entries(home)).toEqual([])
    })
  })

  // PR #712 security review round 1 (P2): the copy is moved into
  // <profile>/runtime/<version>, so that directory is pinned too, apart from
  // the runtime directory above it, and checked again with the destination's
  // absence right before the rename.
  it("refuses to publish when the version directory alone is swapped for a link during the copy", async () => {
    await withScratch(async ({ root, resources, home }) => {
      const versions = join(home, ".domovoi", "runtime", "0.9.4")
      const elsewhere = join(root, "elsewhere")
      await mkdir(elsewhere)
      const copy = async (from: string, to: string) => {
        await nodeRuntimeFileSystem().copy(from, to)
        await rename(versions, join(root, "moved-version"))
        await symlink(elsewhere, versions, directoryLink)
      }
      await expect(stage({ resources, home, version: "0.9.4", copy }))
        .rejects.toThrow(`${versions} changed while the runtime was copied, so it was not published.`)
      expect(await readdir(elsewhere)).toEqual([])
      expect(await readdir(join(root, "moved-version"))).toEqual([])
    })
  })

  it("refuses to publish when the version directory is replaced by another directory during the copy", async () => {
    await withScratch(async ({ root, resources, home }) => {
      const versions = join(home, ".domovoi", "runtime", "0.9.4")
      const copy = async (from: string, to: string) => {
        await nodeRuntimeFileSystem().copy(from, to)
        await rename(versions, join(root, "moved-version"))
        await mkdir(versions)
      }
      await expect(stage({ resources, home, version: "0.9.4", copy }))
        .rejects.toThrow(`${versions} changed while the runtime was copied, so it was not published.`)
      expect(await readdir(versions)).toEqual([])
    })
  })

  // PR #712 security review round 2 (P2): the checks below leave windows
  // between check and use (Q411 A), which only a process of this user may
  // reach. So a staging place, and every directory above it, must be one
  // no other account can change: owned by this user or root, and not
  // writable by group or others unless it is root's and sticky, as /tmp is.
  describe.skipIf(process.platform === "win32")("who else can change the staging place", () => {
    const me = process.getuid?.() ?? -1
    // Owner and mode as lstat would report them for the paths named.
    const permissions = (answers: Record<string, { uid: number; mode: number }>) => {
      const real = nodeRuntimeFileSystem().permissions
      return nodeRuntimeFileSystem({ permissions: async (path) => answers[path] ?? real(path) })
    }
    const prepare = (resources: string, home: string, stagingParent: string, fileSystem: RuntimeFileSystem) =>
      prepareDaemonRuntime({ resourcesPath: resources, profileDirectory: join(home, ".domovoi"), version: "0.9.4", platform, stagingParent, fileSystem })

    it.each([
      ["group-writable and not sticky", 0o40775, () => me],
      ["writable by others and not sticky", 0o40777, () => me],
      ["writable by others and sticky but not root's", 0o41777, () => me],
      ["owned by another account", 0o40755, () => me + 1],
    ])("refuses a staging directory %s, naming it and writing nothing", async (_label, mode, uid) => {
      await withScratch(async ({ root, resources, home }) => {
        const staging = join(root, "staging")
        await expect(prepare(resources, home, staging, permissions({ [staging]: { uid: uid(), mode } })))
          .rejects.toMatchObject({ name: "DaemonRuntimeStagingRefusedError", failed: staging })
        expect(await readdir(staging)).toEqual([])
        expect(await entries(home)).toEqual([])
      })
    })

    it("refuses a staging directory under a directory others can write, naming that one", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const staging = join(root, "staging")
        await expect(prepare(resources, home, staging, permissions({ [root]: { uid: me, mode: 0o40777 } })))
          .rejects.toMatchObject({ name: "DaemonRuntimeStagingRefusedError", failed: root })
        expect(await readdir(staging)).toEqual([])
      })
    })

    // A place on the profile's volume that fails the access gate is refused
    // for that, and the app's refusal says which check failed instead of a
    // different volume.
    it.each([
      ["group or others can write", 0o40775, () => me, (path: string) => `The runtime could not be copied out of the app: group or others can write ${path}, and Domovoi stages the copy only where no other account can change it. Remove their write access to ${path}, then try again. Nothing was changed.`],
      ["another account owns", 0o40755, () => me + 1, (path: string) => `The runtime could not be copied out of the app: ${path} belongs to another account, and Domovoi stages the copy only where no other account can change it. Nothing was changed.`],
    ])("says the staging place failed because %s it, not that it is on a different volume", async (_label, mode, uid, words) => {
      await withScratch(async ({ root, resources, home }) => {
        const staging = join(root, "staging")
        const refused = prepare(resources, home, staging, permissions({ [staging]: { uid: uid(), mode } }))
        await expect(refused).rejects.toThrow(words(staging))
        await expect(refused).rejects.not.toThrow("different volume")
      })
    })

    it("names the directories it made before an access refusal", () => {
      const refused = new DaemonRuntimeStagingRefusedError("/home/dana/.domovoi", "/home/dana/.local", ["/home/dana/.local/state"], { path: "/home/dana/.local", access: "another-account" }, "linux")
      expect(refused.message).toBe("The runtime could not be copied out of the app: /home/dana/.local belongs to another account, and Domovoi stages the copy only where no other account can change it. It made /home/dana/.local/state, which hold no files, and changed nothing else.")
    })

    it("accepts a staging directory that is root's and sticky, as /tmp is", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const staging = join(root, "staging")
        const prepared = await prepare(resources, home, staging, permissions({ [staging]: { uid: 0, mode: 0o41777 } }))
        await prepared.publish()
        expect(await readFile(prepared.runtime.daemonEntryPath, "utf8")).toBe("daemon")
      })
    })

    // PR #712 security review round 3 (P2-1): the gate checks the real path
    // of the place, so every later staging call goes through that real path,
    // never the spelling given: a link above the place, in a directory
    // another account can write, could otherwise be retargeted after the
    // check. Here that account retargets it once the place is checked.
    describe("reached through a link in a directory another account can write", () => {
      async function linked(root: string) {
        const open = join(root, "open")
        const kept = join(root, "kept")
        const elsewhere = join(root, "elsewhere")
        await mkdir(open)
        await mkdir(join(kept, "staging"), { recursive: true })
        await mkdir(join(kept, "home"), { recursive: true })
        await mkdir(join(elsewhere, "staging"), { recursive: true })
        await mkdir(join(elsewhere, "home"), { recursive: true })
        const link = join(open, "link")
        await symlink(kept, link, directoryLink)
        const retarget = async () => {
          await unlink(link)
          await symlink(elsewhere, link, directoryLink)
        }
        // The directory holding the link is one the gate refuses.
        const answers = { [open]: { uid: me + 1, mode: 0o41777 } }
        expect(await unprotectedStagingDirectory(open, { platform, fileSystem: permissions(answers) })).toBe(open)
        return { kept, elsewhere, link, retarget, fileSystem: permissions(answers) }
      }

      it("stages the given place at its checked real path, writing nothing where the link is retargeted", async () => {
        await withScratch(async ({ root, resources, home }) => {
          const { kept, elsewhere, link, retarget, fileSystem: real } = await linked(root)
          const writes: string[] = []
          const fileSystem: RuntimeFileSystem = {
            ...real,
            makePrivateDirectory: async (prefix) => {
              await retarget()
              writes.push(prefix)
              return real.makePrivateDirectory(prefix)
            },
            copy: async (from, to) => { writes.push(to); await real.copy(from, to) },
            rename: async (from, to) => { writes.push(from); await real.rename(from, to) },
          }
          const prepared = await prepare(resources, home, join(link, "staging"), fileSystem)
          await prepared.publish()
          expect(await readFile(prepared.runtime.daemonEntryPath, "utf8")).toBe("daemon")
          expect(writes).toHaveLength(3)
          expect(writes.filter((path) => !path.startsWith(`${join(kept, "staging")}${sep}`))).toEqual([])
          expect(await readdir(join(elsewhere, "staging"))).toEqual([])
          expect(await leftStaging(join(kept, "staging"))).toEqual([[]])
        })
      })

      it("makes the missing data directories under the checked real path, writing nothing where the link is retargeted", async () => {
        await withScratch(async ({ root, resources, home }) => {
          const { kept, elsewhere, link, retarget, fileSystem: real } = await linked(root)
          const made: string[] = []
          const fileSystem: RuntimeFileSystem = {
            ...real,
            // The system temporary directory is on another volume.
            identity: async (path) => path === tmpdir() ? "other-volume:1" : real.identity(path),
            makeDirectory: async (path) => {
              if (made.length === 0) await retarget()
              made.push(path)
              await real.makeDirectory(path)
            },
            makePrivateDirectory: async (prefix) => { made.push(prefix); return real.makePrivateDirectory(prefix) },
          }
          const dataDirectory = join(link, "home", "state", "domovoi")
          const prepared = await prepareDaemonRuntime({ resourcesPath: resources, profileDirectory: join(home, ".domovoi"), version: "0.9.4", platform, dataDirectory, fileSystem })
          await prepared.publish()
          expect(await readFile(prepared.runtime.daemonEntryPath, "utf8")).toBe("daemon")
          const state = join(kept, "home", "state")
          expect(made.filter((path) => !path.startsWith(`${home}${sep}`))).toEqual([
            state, join(state, "domovoi"), join(state, "domovoi", "runtime-staging"),
            expect.stringMatching(/[\\/]runtime-staging[\\/]\.domovoi-runtime-0\.9\.4\.staging-$/u),
          ])
          expect(made.at(-1)!.startsWith(join(state, "domovoi", "runtime-staging"))).toBe(true)
          expect(await readdir(join(elsewhere, "home"))).toEqual([])
          expect(await leftStaging(join(state, "domovoi", "runtime-staging"))).toEqual([[]])
        })
      })
    })

    // PR #712 security review round 3 (P2-2), ruled Q415 A: on macOS an
    // access control entry can let another account change a directory whose
    // owner and mode pass. So each level's list is read too, and one that
    // allows any principal but this user to change it fails the place. Deny
    // entries pass: macOS gives every home folder "group:everyone deny
    // delete". The private staging directory must have no entry at all.
    describe("macOS access control entries", () => {
      const allow = (principal: string, rights: string[], inherited = false): AccessControlEntry => ({ principal, inherited, allow: true, rights })
      const deny = (principal: string, rights: string[]): AccessControlEntry => ({ principal, inherited: false, allow: false, rights })
      // Entries as `ls -le` would list them for the paths named, none
      // elsewhere; holder is what the private staging directory has.
      const listed = (answers: Record<string, AccessControlEntry[] | Error>, holder: AccessControlEntry[] = []) => nodeRuntimeFileSystem({
        accessControl: async (path) => {
          const found = basename(path).startsWith(".domovoi-runtime-") ? holder : answers[path] ?? []
          if (found instanceof Error) throw found
          return found
        },
      })
      const prepareOnMac = (resources: string, home: string, stagingParent: string, fileSystem: RuntimeFileSystem) =>
        prepareDaemonRuntime({ resourcesPath: resources, profileDirectory: join(home, ".domovoi"), version: "0.9.4", platform: "darwin", stagingParent, fileSystem })

      it.each([
        ["lets a group add files", [allow("group:staff", ["add_file"])]],
        ["lets everyone remove entries", [deny("group:everyone", ["delete"]), allow("group:everyone", ["list", "delete_child"])]],
        ["lets another user change its access rules", [allow("user:someone", ["writesecurity"])]],
        ["inherits a grant that lets a group make directories", [allow("group:staff", ["add_subdirectory", "file_inherit", "directory_inherit"], true)]],
      ])("refuses a staging directory whose list %s, naming it without a chmod reason and writing nothing", async (_label, list) => {
        await withScratch(async ({ root, resources, home }) => {
          const staging = join(root, "staging")
          await expect(prepareOnMac(resources, home, staging, listed({ [staging]: list })))
            .rejects.toMatchObject({ name: "DaemonRuntimeStagingRefusedError", failed: staging, access: { path: staging, access: "access-control" } })
          expect(await readdir(staging)).toEqual([])
          expect(await entries(home)).toEqual([])
        })
      })

      it("refuses a staging directory under one whose list lets another principal change it, naming that one", async () => {
        await withScratch(async ({ root, resources, home }) => {
          const staging = join(root, "staging")
          await expect(prepareOnMac(resources, home, staging, listed({ [root]: [allow("group:everyone", ["delete_child"])] })))
            .rejects.toMatchObject({ name: "DaemonRuntimeStagingRefusedError", failed: root, access: { path: root, access: "access-control" } })
          expect(await readdir(staging)).toEqual([])
        })
      })

      it("says an access control entry failed the place, not a different volume", async () => {
        await withScratch(async ({ root, resources, home }) => {
          const staging = join(root, "staging")
          const refused = prepareOnMac(resources, home, staging, listed({ [staging]: [allow("group:staff", ["add_file"])] }))
          await expect(refused).rejects.toThrow(`The runtime could not be copied out of the app: an access control entry on ${staging} lets another account change it, and Domovoi stages the copy only where no other account can change it. Nothing was changed.`)
          await expect(refused).rejects.not.toThrow("different volume")
        })
      })

      it("says who can change the place could not be confirmed when its list cannot be read", async () => {
        await withScratch(async ({ root, resources, home }) => {
          const staging = join(root, "staging")
          await expect(prepareOnMac(resources, home, staging, listed({ [root]: new Error("ls failed") })))
            .rejects.toThrow(`The runtime could not be copied out of the app: Domovoi could not confirm that no other account can change ${staging}, so it did not stage the copy there. Nothing was changed.`)
        })
      })

      it("refuses a staging directory whose list cannot be read", async () => {
        await withScratch(async ({ root, resources, home }) => {
          const staging = join(root, "staging")
          await expect(prepareOnMac(resources, home, staging, listed({ [root]: new Error("ls failed") })))
            .rejects.toMatchObject({ name: "DaemonRuntimeStagingRefusedError", failed: staging, access: { path: staging, access: "unknown" } })
          expect(await readdir(staging)).toEqual([])
        })
      })

      it("accepts deny entries, grants that change nothing, and grants to this user", async () => {
        await withScratch(async ({ root, resources, home }) => {
          const staging = join(root, "staging")
          const fileSystem = listed({
            [staging]: [deny("group:everyone", ["delete"]), allow("group:everyone", ["list", "search", "readattr", "readsecurity"]), allow(`user:${userInfo().username}`, ["add_file", "delete_child", "writesecurity"])],
            [root]: [deny("group:everyone", ["delete"])],
          })
          const prepared = await prepareOnMac(resources, home, staging, fileSystem)
          await prepared.publish()
          expect(await readFile(prepared.runtime.daemonEntryPath, "utf8")).toBe("daemon")
        })
      })

      it("refuses before copying when the private staging directory has any entry, even one that changes nothing", async () => {
        await withScratch(async ({ root, resources, home }) => {
          const staging = join(root, "staging")
          const copy = vi.fn(async () => {})
          const fileSystem = { ...listed({}, [allow("group:staff", ["list"], true)]), copy }
          const prepared = await prepareOnMac(resources, home, staging, fileSystem)
          await expect(prepared.publish()).rejects.toThrow(/changed after it was made, so the runtime was not copied there\.$/u)
          expect(copy).not.toHaveBeenCalled()
        })
      })

      it("reads the entries `ls -le` lists, and refuses a listing it cannot read", () => {
        expect(parseAccessControlListing("drwxr-xr-x@ 83 dana  staff  2656 Oct  3 02:26 /Users/dana\n 0: group:everyone deny delete\n")).toEqual([deny("group:everyone", ["delete"])])
        expect(parseAccessControlListing("drwx------  2 dana  staff  64 Oct  3 02:27 /tmp/x\n")).toEqual([])
        expect(parseAccessControlListing([
          "drwxr-xr-x@ 2 dana  staff  64 Oct  3 02:27 /tmp/x",
          " 0: group:everyone deny delete",
          " 1: group:staff inherited allow add_file,delete_child,file_inherit,directory_inherit",
          "",
        ].join("\n"))).toEqual([deny("group:everyone", ["delete"]), allow("group:staff", ["add_file", "delete_child", "file_inherit", "directory_inherit"], true)])
        for (const listing of ["", "drwx------ 2 dana staff 64 Oct 3 02:27 /tmp/x\n 0: group:staff maybe add_file\n", "drwx------ 2 dana staff 64 Oct 3 02:27 /tmp/x\n 1: group:staff allow add_file\n", "drwx------ 2 dana staff 64 Oct 3 02:27 /tmp/x\nwith a newline in its name\n"]) {
          expect(() => parseAccessControlListing(listing), listing).toThrow()
        }
      })

      // The real list, on a Mac: chmod +a adds an entry to a scratch
      // directory, and chmod -N clears it again before the scratch is removed.
      it.runIf(process.platform === "darwin")("accepts a real directory with no entries or a deny entry, and refuses one that lets a group add files", async () => {
        await withScratch(async ({ root }) => {
          const staging = join(root, "staging")
          const check = () => unprotectedStagingDirectory(staging, { platform: "darwin", fileSystem: nodeRuntimeFileSystem() })
          try {
            expect(await check()).toBeUndefined()
            await run("/bin/chmod", ["+a", "group:everyone deny delete", staging])
            expect(await check()).toBeUndefined()
            await run("/bin/chmod", ["+a", "group:staff allow add_file", staging])
            expect(await check()).toBe(staging)
          } finally {
            await run("/bin/chmod", ["-N", staging])
          }
        })
      })
    })

    it("refuses at publish a staging directory others could change only after it was prepared", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const staging = join(root, "staging")
        const answers: Record<string, { uid: number; mode: number }> = {}
        const prepared = await prepare(resources, home, staging, permissions(answers))
        answers[staging] = { uid: me, mode: 0o40777 }
        await expect(prepared.publish()).rejects.toThrow(`${staging} changed after it was checked, so the runtime was not copied there.`)
        expect(await readdir(staging)).toEqual([])
        // Publish makes the profile's runtime directories under its lease
        // before it reaches the staging place; no copy is published there.
        expect(await readdir(join(home, ".domovoi", "runtime", "0.9.4"))).toEqual([])
      })
    })
  })

  // Windows: Node cannot read ACLs, so a staging place is accepted only
  // inside this user's own profile directory, where the default TEMP
  // (%LOCALAPPDATA%\Temp) and the app's userData (%APPDATA%) are.
  //
  // PR #712 security review round 3 (P2-4): inside the profile is decided by
  // file system identity, an ancestor that is the profile directory itself,
  // not by comparing names case-folded: a directory with per-directory case
  // sensitivity can hold a sibling of the profile whose name differs only in
  // case.
  describe("on Windows", () => {
    // Device and inode as lstat would report them. On a case-insensitive
    // directory every spelling of a name is the same entry, so by default the
    // identity follows the name case-folded; distinct lists entries that are
    // not, and unreadable those whose identity cannot be read.
    const fileSystem = (distinct: Record<string, string> = {}, unreadable: string[] = []) => nodeRuntimeFileSystem({
      realpath: async (path) => path,
      identity: async (path) => {
        if (unreadable.includes(path)) throw new Error("EPERM")
        return distinct[path] ?? `7:${path.toLowerCase()}`
      },
      permissions: async () => { throw new Error("Windows has no POSIX owner or mode to read") },
    })
    const check = (path: string, files = fileSystem()) => unprotectedStagingDirectory(path, { platform: "win32", fileSystem: files, userDirectory: "C:\\Users\\dana" })

    it("accepts a place inside the user's profile and names one outside it", async () => {
      expect(await check("C:\\Users\\dana\\AppData\\Local\\Temp")).toBeUndefined()
      expect(await check("c:\\users\\DANA\\AppData\\Roaming\\Domovoi")).toBeUndefined()
      expect(await check("D:\\shared\\temp")).toBe("D:\\shared\\temp")
      expect(await check("C:\\Windows\\Temp")).toBe("C:\\Windows\\Temp")
    })

    it("refuses a place under a case-sensitive sibling of the profile whose name differs only in case", async () => {
      const files = fileSystem({ "C:\\Users\\Dana": "7:sibling" })
      expect(await check("C:\\Users\\Dana\\Temp", files)).toBe("C:\\Users\\Dana\\Temp")
      expect(await check("C:\\Users\\dana\\AppData\\Local\\Temp", files)).toBeUndefined()
    })

    it("refuses a place whose ancestry or profile cannot be identified", async () => {
      expect(await check("C:\\Users\\dana\\AppData\\Local\\Temp", fileSystem({}, ["C:\\Users\\dana\\AppData"]))).toBe("C:\\Users\\dana\\AppData\\Local\\Temp")
      expect(await check("C:\\Users\\dana\\AppData\\Local\\Temp", fileSystem({}, ["C:\\Users\\dana"]))).toBe("C:\\Users\\dana\\AppData\\Local\\Temp")
    })

    // Round 4 (P2-4): a file system with no unique 64-bit file id answers 0,
    // or all ones (ReFS when its 128-bit id does not fit), without failing.
    // Two such answers are equal without being the same directory.
    // Node reads stat fields through a signed 64-bit array, so all ones
    // arrives as -1 (round 5); the unsigned spelling is kept as well.
    it.each([["0"], ["-1"], ["18446744073709551615"]])("refuses a place when the file id read is %s, which names no one directory", async (ino) => {
      const unknown = `7:${ino}`
      const files = fileSystem({ "C:\\Users\\dana": unknown, "C:\\Users\\Dana": unknown, "C:\\Users\\Dana\\Temp": unknown })
      expect(await check("C:\\Users\\Dana\\Temp", files)).toBe("C:\\Users\\Dana\\Temp")
      expect(await check("C:\\Users\\dana\\AppData\\Local\\Temp", files)).toBe("C:\\Users\\dana\\AppData\\Local\\Temp")
    })

    // Q416 B: Windows access rules are not read, so the refusal says the
    // place is not shown to be inside the profile, never that it was checked
    // for who can change it.
    it("says a place outside the user's profile failed, not a different volume", () => {
      const refused = new DaemonRuntimeStagingRefusedError("C:\\Users\\dana\\.domovoi", "D:\\shared\\temp", [], { path: "D:\\shared\\temp", access: "unknown" }, "win32")
      expect(refused.message).toBe("The runtime could not be copied out of the app: Domovoi could not confirm that D:\\shared\\temp is inside your user profile, the only place it stages the copy on Windows, since it does not read Windows access rules. Nothing was changed.")
    })
  })

  // PR #712 security review round 1 (P2): the staging place is checked when
  // it is chosen or made, and again right before the private staging
  // directory is made in it; that directory is checked before the copy goes
  // in and before the copy is moved out. Nothing is written in a repository
  // swapped in, and nothing is removed.
  describe("when the staging place changes after it was checked", () => {
    const tmpdirElsewhere = (overrides: Partial<RuntimeFileSystem> = {}) => {
      const identity = nodeRuntimeFileSystem().identity
      return nodeRuntimeFileSystem({ identity: async (path) => path === tmpdir() ? "other-volume:1" : identity(path), ...overrides })
    }
    async function repository(root: string): Promise<string> {
      const at = join(root, "repository")
      await mkdir(join(at, ".git"), { recursive: true })
      return at
    }

    it.each([
      ["the staging directory given", (root: string) => ({ stagingParent: join(root, "staging") }), (root: string) => join(root, "staging")],
      ["an existing runtime-staging under the data directory", (root: string) => ({ dataDirectory: join(root, "data") }), (root: string) => join(root, "data", "runtime-staging")],
    ] as const)("refuses, writing nothing there, when %s is swapped between preparing and publishing", async (_label, place, parent) => {
      await withScratch(async ({ root, resources, home }) => {
        await mkdir(join(root, "data", "runtime-staging"), { recursive: true })
        const target = await repository(root)
        const prepared = await prepareDaemonRuntime({ resourcesPath: resources, profileDirectory: join(home, ".domovoi"), version: "0.9.4", platform, fileSystem: tmpdirElsewhere(), ...place(root) })
        await rename(parent(root), `${parent(root)}-moved`)
        await symlink(target, parent(root), directoryLink)
        await expect(prepared.publish()).rejects.toThrow(`${parent(root)} changed after it was checked, so the runtime was not copied there.`)
        expect(await readdir(target)).toEqual([".git"])
        expect(await readdir(`${parent(root)}-moved`)).toEqual([])
      })
    })

    it("refuses, writing nothing there, when runtime-staging is swapped after the last level made is checked", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const target = await repository(root)
        const staging = join(root, "data", "runtime-staging")
        const real = nodeRuntimeFileSystem()
        // The version directory is made after every staging level is made
        // and checked, and before the private staging directory is.
        const makeDirectory = async (path: string) => {
          await real.makeDirectory(path)
          if (path === join(home, ".domovoi", "runtime", "0.9.4")) {
            await rename(staging, `${staging}-moved`)
            await symlink(target, staging, directoryLink)
          }
        }
        const prepared = await prepareDaemonRuntime({ resourcesPath: resources, profileDirectory: join(home, ".domovoi"), version: "0.9.4", platform, dataDirectory: join(root, "data"), fileSystem: tmpdirElsewhere({ makeDirectory }) })
        await expect(prepared.publish()).rejects.toThrow(`${staging} changed after it was checked, so the runtime was not copied there.`)
        expect(await readdir(target)).toEqual([".git"])
      })
    })

    it("refuses before copying when the private staging directory is swapped for a link once made", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const target = await repository(root)
        const real = nodeRuntimeFileSystem()
        let holder: string | undefined
        const makePrivateDirectory = async (prefix: string) => {
          holder = await real.makePrivateDirectory(prefix)
          await rename(holder, `${holder}-moved`)
          await symlink(target, holder, directoryLink)
          return holder
        }
        await expect(stage({ resources, home, version: "0.9.4", makePrivateDirectory }))
          .rejects.toThrow(/changed after it was made, so the runtime was not copied there\.$/u)
        expect(await readdir(target)).toEqual([".git"])
        expect(await readdir(`${holder!}-moved`)).toEqual([])
      })
    })

    it("refuses to publish when the private staging directory is swapped after the copy", async () => {
      await withScratch(async ({ root, resources, home }) => {
        const planted = join(root, "planted")
        await mkdir(join(planted, "copy", "daemon", "dist"), { recursive: true })
        await writeFile(join(planted, "copy", "daemon", "dist", "index.js"), "not the shipped daemon")
        const copy = async (from: string, to: string) => {
          await nodeRuntimeFileSystem().copy(from, to)
          const holder = dirname(to)
          await rename(holder, `${holder}-moved`)
          await symlink(planted, holder, directoryLink)
        }
        await expect(stage({ resources, home, version: "0.9.4", copy }))
          .rejects.toThrow(/changed while the runtime was copied, so it was not published\.$/u)
        expect(await readdir(join(home, ".domovoi", "runtime", "0.9.4"))).toEqual([])
        expect(await readdir(planted)).toEqual(["copy"])
      })
    })
  })

  // The daemon's approved words for an update (update-outcome, 2026-09-23).
  it("says the service was not updated when the shipped part is missing for an update", async () => {
    await expect(stageDaemonRuntime({
      resourcesPath: "/r", profileDirectory: "/Users/dana/.domovoi", version: "0.9.4", platform: "darwin", operation: "update",
      fileSystem: nodeRuntimeFileSystem({ entry: async () => "missing", copy: vi.fn(), rename: async () => {} }),
    })).rejects.toThrow("The Node runtime this app ships was not found at /r/daemon-runtime/node/bin/node. The service was not updated and no service files were changed.")
  })
})

const platform = process.platform === "win32" ? "win32" : "linux"
const directoryLink = process.platform === "win32" ? "junction" : "dir"

// Round 7: the fresh <version>/<id> directory a published runtime is in.
function copyOf(runtime: { daemonEntryPath: string }): string {
  return dirname(dirname(dirname(runtime.daemonEntryPath)))
}

function daemonRuntimeLayoutUnder(destination: string) {
  return platform === "win32"
    ? { nodePath: join(destination, "node", "node.exe"), daemonEntryPath: join(destination, "daemon", "dist", "index.js") }
    : { nodePath: join(destination, "node", "bin", "node"), daemonEntryPath: join(destination, "daemon", "dist", "index.js") }
}

// Real files in a scratch directory: the shipped runtime under Resources and
// an empty home. Nothing here reaches the real profile.
async function withScratch(run: (paths: { root: string; resources: string; home: string }) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-stage-")))
  try {
    const resources = join(root, "Resources")
    const shipped = daemonRuntimeLayout(resources, platform)
    await mkdir(dirname(shipped.nodePath), { recursive: true })
    await mkdir(dirname(shipped.daemonEntryPath), { recursive: true })
    await writeFile(shipped.nodePath, "node")
    await writeFile(shipped.daemonEntryPath, "daemon")
    const home = join(root, "home")
    await mkdir(home)
    await mkdir(join(root, "staging"))
    await run({ root, resources, home })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function entries(path: string): Promise<string[]> {
  return (await readdir(path)).sort()
}

// What each staging directory a publish left under parent holds.
async function leftStaging(parent: string): Promise<string[][]> {
  const names = await readdir(parent)
  expect(names.every((name) => name.startsWith(".domovoi-runtime-0.9.4.staging-"))).toBe(true)
  return Promise.all(names.map((name) => readdir(join(parent, name))))
}

type StageInput = {
  resources: string
  home: string
  version: string
  copy?: (from: string, to: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  entry?: RuntimeFileSystem["entry"]
  makePrivateDirectory?: RuntimeFileSystem["makePrivateDirectory"]
}

function stage(input: StageInput) {
  return stageDaemonRuntime({
    resourcesPath: input.resources, profileDirectory: join(input.home, ".domovoi"), version: input.version, platform,
    // The private staging directory stays inside the scratch root.
    stagingParent: join(dirname(input.home), "staging"),
    fileSystem: nodeRuntimeFileSystem({
      ...(input.copy ? { copy: input.copy } : {}),
      ...(input.rename ? { rename: input.rename } : {}),
      ...(input.entry ? { entry: input.entry } : {}),
      ...(input.makePrivateDirectory ? { makePrivateDirectory: input.makePrivateDirectory } : {}),
    }),
  })
}
