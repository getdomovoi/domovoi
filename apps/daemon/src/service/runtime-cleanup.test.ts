import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readDaemonServiceRuntimeCopy, removeUnusedDaemonRuntimes } from "../public.js"
import { claimServiceOperation } from "./operation-lease.js"
import { copyLayout, fakeServiceManager, publishCopy, serviceDefinition } from "./runtime-copy.test-support.js"

// #635, ruled Q60 A: each desktop install or update publishes the daemon
// runtime into a fresh <profile>/runtime/<version>/<id>, and nothing removed
// the copies. The cleanup removes the copies no service definition names,
// under the service-operation lease, after the new service is confirmed, and
// keeps anything it is not certain about. Every directory here is real and
// temporary; the service manager is a fake that reports one definition.

let root: string
let home: string
let profile: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "domovoi-runtime-cleanup-"))
  home = join(root, "home")
  profile = join(home, ".domovoi")
  await mkdir(profile, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const exists = (path: string) => lstat(path).then(() => true, () => false)
// Windows makes a directory link without elevation only as a junction.
const linkDirectory = (target: string, path: string) => symlink(target, path, process.platform === "win32" ? "junction" : "dir")

function dependencies(manager: ReturnType<typeof fakeServiceManager>) {
  return { ...manager.reader, claimServiceOperation: () => claimServiceOperation(home) }
}

describe("removeUnusedDaemonRuntimes", () => {
  it("removes the copies no service definition names and keeps the current and previous ones", async () => {
    const oldest = await publishCopy(profile, "0.9.0", "aaaaaaaaaaaa")
    const older = await publishCopy(profile, "0.9.1", "bbbbbbbbbbbb")
    const previous = await publishCopy(profile, "0.9.1", "cccccccccccc")
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home)
    manager.register(current)

    const result = await removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: true, copy: previous } }, dependencies(manager))

    expect(result).toEqual({ removed: expect.arrayContaining([oldest, older]) as unknown })
    expect(result).toMatchObject({ removed: { length: 2 } })
    expect(await exists(oldest)).toBe(false)
    expect(await exists(older)).toBe(false)
    expect(await exists(copyLayout(previous).nodePath)).toBe(true)
    expect(await exists(copyLayout(current).daemonEntryPath)).toBe(true)
    // A version directory left empty goes too; one still holding a copy stays.
    expect((await readdir(join(profile, "runtime"))).sort()).toEqual(["0.9.1", "0.9.2"])
    expect(await readdir(join(profile, "runtime", "0.9.1"))).toEqual(["cccccccccccc"])
  })

  it("keeps the published copy when no service ran before it", async () => {
    const leftover = await publishCopy(profile, "0.9.1", "bbbbbbbbbbbb")
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home)
    manager.register(current)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: false } }, dependencies(manager)))
      .resolves.toEqual({ removed: [leftover] })
    expect(await exists(current)).toBe(true)
  })

  it("works under a profile other than the default one", async () => {
    const work = join(root, "profiles", "work")
    await mkdir(work, { recursive: true })
    const leftover = await publishCopy(work, "0.9.1", "bbbbbbbbbbbb")
    const current = await publishCopy(work, "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home, work)
    manager.register(current)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: work, published: copyLayout(current), previous: { installed: false } }, dependencies(manager)))
      .resolves.toEqual({ removed: [leftover] })
    expect(await exists(current)).toBe(true)
  })

  it("keeps everything under the runtime directory that is not a copy it publishes", async () => {
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const runtime = join(profile, "runtime")
    const kept = [
      join(runtime, "notes.txt"),
      join(runtime, "latest", "aaaaaaaaaaaa", "node"),
      join(runtime, "0.9.1", "not-a-copy", "node"),
      join(runtime, "0.9.1", "AAAAAAAAAAAA", "node"),
      join(runtime, "0.9.1", "aaaaaaaaaaaa0", "node"),
    ]
    for (const path of kept) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, "")
    }
    // A file where a copy would be is not a directory it published.
    await writeFile(join(runtime, "0.9.1", "bbbbbbbbbbbb"), "")
    const manager = fakeServiceManager(home)
    manager.register(current)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: false } }, dependencies(manager)))
      .resolves.toEqual({ removed: [] })
    for (const path of kept) expect(await exists(path), path).toBe(true)
    expect(await exists(join(runtime, "0.9.1", "bbbbbbbbbbbb"))).toBe(true)
  })

  it("never follows a link, and keeps what a link leads to", async () => {
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const outside = join(root, "outside")
    const precious = join(outside, "aaaaaaaaaaaa", "precious.txt")
    await mkdir(dirname(precious), { recursive: true })
    await writeFile(precious, "keep")
    const runtime = join(profile, "runtime")
    // A copy's place holding a link, and a version directory that is a link.
    await mkdir(join(runtime, "0.9.1"), { recursive: true })
    await linkDirectory(join(outside, "aaaaaaaaaaaa"), join(runtime, "0.9.1", "eeeeeeeeeeee"))
    await linkDirectory(outside, join(runtime, "0.8.0"))
    const manager = fakeServiceManager(home)
    manager.register(current)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: false } }, dependencies(manager)))
      .resolves.toEqual({ removed: [] })
    expect(await exists(join(runtime, "0.9.1", "eeeeeeeeeeee"))).toBe(true)
    expect(await exists(join(runtime, "0.8.0"))).toBe(true)
    expect(await exists(precious)).toBe(true)
  })

  it("removes nothing when the runtime directory is a link", async () => {
    const elsewhere = join(root, "elsewhere")
    const current = await publishCopy(elsewhere, "0.9.2", "dddddddddddd")
    const leftover = await publishCopy(elsewhere, "0.9.1", "bbbbbbbbbbbb")
    await linkDirectory(join(elsewhere, "runtime"), join(profile, "runtime"))
    const published = join(profile, "runtime", "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home)
    manager.register(published)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(published), previous: { installed: false } }, dependencies(manager)))
      .resolves.toEqual({ skipped: "runtime-directory" })
    expect(await exists(leftover)).toBe(true)
    expect(await exists(current)).toBe(true)
  })

  it("removes nothing when the published copy is not under the profile's runtime directory", async () => {
    const leftover = await publishCopy(profile, "0.9.1", "bbbbbbbbbbbb")
    const other = join(root, "profiles", "other")
    const published = await publishCopy(other, "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home, other)
    manager.register(published)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(published), previous: { installed: false } }, dependencies(manager)))
      .resolves.toEqual({ skipped: "runtime-directory" })
    expect(await exists(leftover)).toBe(true)
  })

  it("puts back a directory that was swapped in after the check, and removes nothing", async () => {
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const leftover = await publishCopy(profile, "0.9.1", "bbbbbbbbbbbb")
    const swapped = join(root, "swapped")
    await mkdir(swapped)
    await writeFile(join(swapped, "precious.txt"), "keep")
    const manager = fakeServiceManager(home)
    manager.register(current)
    const result = await removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: false } }, {
      ...dependencies(manager),
      fileSystem: {
        // Another directory takes the copy's place right before it moves.
        rename: async (from: string, to: string) => {
          if (from === leftover) {
            await rename(leftover, join(root, "moved-away"))
            await rename(swapped, leftover)
          }
          await rename(from, to)
        },
      },
    })
    expect(result).toEqual({ removed: [] })
    expect(await exists(join(leftover, "precious.txt"))).toBe(true)
  })

  it("removes what an interrupted removal left behind", async () => {
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const interrupted = join(profile, "runtime", ".removing-0123456789ab")
    await mkdir(join(interrupted, "node"), { recursive: true })
    const manager = fakeServiceManager(home)
    manager.register(current)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: false } }, dependencies(manager)))
      .resolves.toEqual({ removed: [interrupted] })
    expect(await readdir(join(profile, "runtime"))).toEqual(["0.9.2"])
  })
})

// The issue's scope: another install can take the service between this
// install's confirmation and its cleanup. Only the change whose copy the
// definition names cleans up, and it keeps the copy the one before it ran.
describe("removeUnusedDaemonRuntimes with two installs racing", () => {
  it("leaves the cleanup to the install that holds the service, and never removes its previous copy", async () => {
    const leftover = await publishCopy(profile, "0.9.0", "aaaaaaaaaaaa")
    const first = await publishCopy(profile, "0.9.1", "bbbbbbbbbbbb")
    const manager = fakeServiceManager(home)
    manager.register(first)

    // App A installs: under the lease it reads what the service ran, then
    // publishes and registers its copy.
    const leaseA = claimServiceOperation(home)
    const previousA = await readDaemonServiceRuntimeCopy(manager.reader)
    const copyA = await publishCopy(profile, "0.9.2", "cccccccccccc")
    manager.register(copyA)
    leaseA.release()
    expect(previousA).toEqual({ installed: true, copy: first })

    // App B installs before A cleans up. While B holds the lease, A's
    // cleanup is refused and removes nothing.
    const leaseB = claimServiceOperation(home)
    const previousB = await readDaemonServiceRuntimeCopy(manager.reader)
    const copyB = await publishCopy(profile, "0.9.2", "dddddddddddd")
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(copyA), previous: previousA }, dependencies(manager)))
      .resolves.toEqual({ skipped: "busy" })
    manager.register(copyB)
    leaseB.release()

    // The service now runs B's copy, so A's cleanup removes nothing.
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(copyA), previous: previousA }, dependencies(manager)))
      .resolves.toEqual({ skipped: "service-changed" })
    for (const copy of [leftover, first, copyA, copyB]) expect(await exists(copy), copy).toBe(true)

    // B's cleanup keeps its own copy and A's, which the service ran before.
    const result = await removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(copyB), previous: previousB }, dependencies(manager))
    expect(result).toEqual({ removed: expect.arrayContaining([leftover, first]) as unknown })
    expect(result).toMatchObject({ removed: { length: 2 } })
    expect(await exists(copyA)).toBe(true)
    expect(await exists(copyB)).toBe(true)
  })
})

// Security review round 1 of #635 (P2): every link and directory below is in
// place before any operation starts, so none of it needs a process racing the
// cleanup.
describe("removeUnusedDaemonRuntimes with links laid out ahead of time", () => {
  // The previous copy's version directory is a link into another candidate,
  // an interrupted removal or an ordinary copy, that holds the whole version.
  // The definition still names the copy by its usual <version>/<id> path.
  it.each([".removing-0123456789ab", join("0.8.0", "bbbbbbbbbbbb")])("keeps the previous copy reached through a linked version inside %s", async (container) => {
    const previousCopy = await publishCopy(profile, "0.9.1", "aaaaaaaaaaaa")
    const parked = join(profile, "runtime", container)
    await mkdir(dirname(parked), { recursive: true })
    await rename(dirname(previousCopy), parked)
    await linkDirectory(parked, dirname(previousCopy))
    const manager = fakeServiceManager(home)
    manager.register(previousCopy)

    const lease = claimServiceOperation(home)
    const previous = await readDaemonServiceRuntimeCopy(manager.reader)
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    manager.register(current)
    lease.release()
    expect(previous).toEqual({ installed: true, copy: previousCopy })

    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous }, dependencies(manager)))
      .resolves.toEqual({ removed: [] })
    expect(await exists(copyLayout(previousCopy).nodePath)).toBe(true)
    expect(await exists(copyLayout(previousCopy).daemonEntryPath)).toBe(true)
    expect(await exists(copyLayout(current).nodePath)).toBe(true)
  })

  // lstat of "linked/" or "linked/." looks through the link, so the profile
  // spelled that way passed as a real directory. "linked/x/.." is the link
  // too, once the runtime directory is built from it.
  it.each(["", sep, `${sep}.`, `${sep}x${sep}..`])("removes nothing under a linked profile spelled with %j after it", async (suffix) => {
    const actual = join(root, "actual")
    const old = await publishCopy(actual, "0.9.1", "aaaaaaaaaaaa")
    const copy = await publishCopy(actual, "0.9.2", "dddddddddddd")
    await mkdir(join(actual, "x"))
    const link = join(root, "linked")
    await linkDirectory(actual, link)
    const linked = link + suffix
    const current = join(linked, "runtime", "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home, linked)
    manager.register(current)
    await expect(readDaemonServiceRuntimeCopy(manager.reader)).resolves.toEqual({ installed: true, copy: current })

    await expect(removeUnusedDaemonRuntimes({ profileDirectory: linked, published: copyLayout(current), previous: { installed: false } }, dependencies(manager)))
      .resolves.toEqual({ skipped: "runtime-directory" })
    expect(await exists(copyLayout(old).nodePath)).toBe(true)
    expect(await exists(copyLayout(copy).nodePath)).toBe(true)
  })

  it("removes nothing when a kept copy cannot be resolved, and keeps a candidate that cannot be", async () => {
    const leftover = await publishCopy(profile, "0.9.0", "aaaaaaaaaaaa")
    const previousCopy = await publishCopy(profile, "0.9.1", "bbbbbbbbbbbb")
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home)
    manager.register(current)
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    const refusing = (refused: string) => ({
      ...dependencies(manager),
      fileSystem: { realpath: async (path: string) => { if (path === refused) throw denied; return realpath(path) } },
    })
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: true, copy: previousCopy } }, refusing(previousCopy)))
      .resolves.toEqual({ skipped: "runtime-directory" })
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: true, copy: previousCopy } }, refusing(leftover)))
      .resolves.toEqual({ removed: [] })
    expect(await exists(copyLayout(leftover).nodePath)).toBe(true)
    // A kept copy that is not there holds nothing, so the rest goes.
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: true, copy: join(profile, "runtime", "0.9.1", "cccccccccccc") } }, dependencies(manager)))
      .resolves.toEqual({ removed: expect.arrayContaining([leftover, previousCopy]) as unknown })
    expect(await exists(copyLayout(current).nodePath)).toBe(true)
  })

  it("keeps an interrupted removal's name that is a link, and what it leads to", async () => {
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const outside = join(root, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "precious.txt"), "keep")
    const link = join(profile, "runtime", ".removing-0123456789ab")
    await linkDirectory(outside, link)
    const manager = fakeServiceManager(home)
    manager.register(current)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: false } }, dependencies(manager)))
      .resolves.toEqual({ removed: [] })
    expect(await exists(link)).toBe(true)
    expect(await exists(join(outside, "precious.txt"))).toBe(true)
  })
})

// A definition only names a copy when it is exactly what an install writes for
// it (stagedRuntimeVersion). Anything else leaves the cleanup unsure, and it
// removes nothing.
describe("removeUnusedDaemonRuntimes with a crafted service definition", () => {
  it("removes nothing when the current definition does not name the published copy exactly", async () => {
    const leftover = await publishCopy(profile, "0.9.1", "bbbbbbbbbbbb")
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const other = join(root, "profiles", "other")
    await publishCopy(other, "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home)
    const written = serviceDefinition(current, manager.configurationPath)
    const crafted = [
      // The published copy reached through a "..", which path.join would
      // fold away, so the text is replaced in what an install writes.
      written.replaceAll(current, join(profile, "runtime", "0.9.2", "eeeeeeeeeeee") + `${sep}..${sep}dddddddddddd`),
      // The same names under another profile.
      serviceDefinition(join(other, "runtime", "0.9.2", "dddddddddddd"), manager.configurationPath),
      // Another copy under this profile.
      serviceDefinition(leftover, manager.configurationPath),
      // The id in another case.
      serviceDefinition(join(profile, "runtime", "0.9.2", "DDDDDDDDDDDD"), manager.configurationPath),
      // The copy's Node on another service configuration.
      serviceDefinition(current, join(root, "planted", "service.json")),
    ]
    expect(new Set(crafted).size).toBe(crafted.length)
    for (const definition of crafted) {
      expect(definition).not.toBe(written)
      manager.craft(definition)
      await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: false } }, dependencies(manager)), definition)
        .resolves.toEqual({ skipped: "service-changed" })
    }
    // The written definition itself is accepted, so the refusals above are
    // about the crafted text alone.
    manager.craft(written)
    await expect(readDaemonServiceRuntimeCopy(manager.reader)).resolves.toEqual({ installed: true, copy: current })
    // No definition at all.
    const none = fakeServiceManager(home)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: false } }, dependencies(none)))
      .resolves.toEqual({ skipped: "service-changed" })
    expect(await exists(leftover)).toBe(true)
  })

  it("removes nothing when the previous definition named something other than a copy", async () => {
    const leftover = await publishCopy(profile, "0.9.1", "bbbbbbbbbbbb")
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home)
    manager.register(current)
    await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: true } }, dependencies(manager)))
      .resolves.toEqual({ skipped: "previous-unknown" })
    expect(await exists(leftover)).toBe(true)
  })

  it("removes nothing when the definition or the saved configuration cannot be read", async () => {
    const leftover = await publishCopy(profile, "0.9.1", "bbbbbbbbbbbb")
    const current = await publishCopy(profile, "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home)
    manager.register(current)
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    const unreadable = [
      { ...dependencies(manager), readDefinition: async () => { throw denied }, capture: async () => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied." }) },
      { ...dependencies(manager), readConfiguration: () => { throw new Error("not a Domovoi service configuration") } },
    ]
    for (const reader of unreadable) {
      await expect(removeUnusedDaemonRuntimes({ profileDirectory: profile, published: copyLayout(current), previous: { installed: false } }, reader))
        .resolves.toEqual({ skipped: "definition-unknown" })
    }
    expect(await exists(leftover)).toBe(true)
  })
})

describe("readDaemonServiceRuntimeCopy", () => {
  it("names the copy the definition runs, and nothing for a service it did not publish", async () => {
    const current = join(profile, "runtime", "0.9.2", "dddddddddddd")
    const manager = fakeServiceManager(home)
    await expect(readDaemonServiceRuntimeCopy(manager.reader)).resolves.toEqual({ installed: false })
    manager.register(current)
    await expect(readDaemonServiceRuntimeCopy(manager.reader)).resolves.toEqual({ installed: true, copy: current })
    manager.register(join(root, "elsewhere", "runtime", "0.9.2", "dddddddddddd"))
    await expect(readDaemonServiceRuntimeCopy(manager.reader)).resolves.toEqual({ installed: true })
  })

  it("throws, rather than say no service is installed, when a read fails", async () => {
    const manager = fakeServiceManager(home)
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    await expect(readDaemonServiceRuntimeCopy({ ...manager.reader, readDefinition: async () => { throw denied }, capture: async () => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied." }) }))
      .rejects.toThrow()
    manager.register(join(profile, "runtime", "0.9.2", "dddddddddddd"))
    await expect(readDaemonServiceRuntimeCopy({ ...manager.reader, readConfiguration: () => { throw new Error("not a Domovoi service configuration") } }))
      .rejects.toThrow("not a Domovoi service configuration")
  })

  it("tells a missing Windows task from a query that failed", async () => {
    const windows = { platform: "win32", home: "C:\\Users\\dana", readDefinition: async () => undefined, readConfiguration: () => undefined }
    await expect(readDaemonServiceRuntimeCopy({ ...windows, capture: async () => ({ code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }) }))
      .resolves.toEqual({ installed: false })
    await expect(readDaemonServiceRuntimeCopy({ ...windows, capture: async () => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied." }) }))
      .rejects.toThrow()
  })
})
