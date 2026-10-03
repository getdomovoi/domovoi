import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { daemonRuntimeLayout, nodeRuntimeFileSystem, prepareDaemonRuntime, profileRuntimeDirectory, stageDaemonRuntime, type RuntimeFileSystem } from "./runtime-stage.js"

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
    }),
  })
}
