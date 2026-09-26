import type { BigIntStats, PathLike, StatSyncOptions, Stats } from "node:fs"
import { rmSync, symlinkSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A stat the test controls for one path, so a directory can report the device
// and inode another directory had. On ext4 a new directory can get the inode
// number of one just deleted; this stands in for that without depending on
// the filesystem to reuse it.
const statOverrides = vi.hoisted(() => new Map<string, { dev: bigint; ino: bigint }>())
// A canonical-path lookup the test controls for one path: an error code to
// throw, or another path to report. It stands in for a directory removed,
// made unreadable or looped between the stat and the lookup.
const realpathOverrides = vi.hoisted(() => new Map<string, { code: string } | { path: string }>())
// Run once, right after the next stat of one path returns. It stands in for
// a symlink retargeted between that stat and the canonical-path lookup.
const afterStat = vi.hoisted(() => new Map<string, () => void>())

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const statSync = ((path: PathLike, options?: StatSyncOptions) => {
    const stats = actual.statSync(path, options)
    const hook = afterStat.get(resolve(String(path)))
    afterStat.delete(resolve(String(path)))
    hook?.()
    const override = statOverrides.get(resolve(String(path)))
    if (override === undefined || stats === undefined) return stats
    return Object.assign(stats as BigIntStats | Stats, override)
  }) as typeof actual.statSync
  const native = ((path: PathLike, options?: unknown) => {
    const override = realpathOverrides.get(resolve(String(path)))
    if (override === undefined) return actual.realpathSync.native(path, options as never)
    if ("path" in override) return override.path
    throw Object.assign(new Error(`${override.code}: injected by the test`), { code: override.code })
  }) as typeof actual.realpathSync.native
  const realpathSync = Object.assign(
    ((path: PathLike, options?: unknown) => actual.realpathSync(path, options as never)) as typeof actual.realpathSync,
    { native },
  )
  return { ...actual, statSync, realpathSync, default: { ...actual, statSync, realpathSync } }
})

const { captureInheritedCredentials, resetKeptCredentialsForTests, withInheritedCredentials } = await import("./inherited-credentials.js")

const names = ["DOMOVOI_AUTH_TOKEN", "DOMOVOI_CREDENTIAL_PATH", "DOMOVOI_RELAY_CREDENTIAL_FILE", "DOMOVOI_PROFILE_DIR"] as const
let saved: Partial<Record<(typeof names)[number], string>> = {}
let root: string

beforeEach(async () => {
  saved = {}
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined) saved[name] = value
    delete process.env[name]
  }
  root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-kept-")))
})

afterEach(async () => {
  statOverrides.clear()
  realpathOverrides.clear()
  afterStat.clear()
  resetKeptCredentialsForTests()
  for (const name of names) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(root, { recursive: true, force: true })
})

describe("kept inherited credentials", () => {
  // The values here are placeholders, not bearers. Assertions check only
  // whether a value was filled in, so a failure never prints one.
  it("does not hand the kept bearer to a directory at another path that reports the same device and inode", async () => {
    const home = join(root, "home")
    const profileA = join(root, "profile-a")
    const profileB = join(root, "profile-b")
    await mkdir(home)
    await mkdir(profileA)
    await mkdir(profileB)

    process.env.DOMOVOI_PROFILE_DIR = profileA
    process.env.DOMOVOI_AUTH_TOKEN = "placeholder-kept-value"
    captureInheritedCredentials(() => home)
    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(true)

    const pinned = (await import("node:fs")).statSync(profileA, { bigint: true })
    statOverrides.set(profileB, { dev: pinned.dev, ino: pinned.ino })
    process.env.DOMOVOI_PROFILE_DIR = profileB

    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(false)
  })

  it("keeps handing the kept bearer to its own profile directory", async () => {
    const home = join(root, "home")
    const profile = join(root, "profile")
    await mkdir(home)
    await mkdir(profile)

    process.env.DOMOVOI_PROFILE_DIR = profile
    process.env.DOMOVOI_AUTH_TOKEN = "placeholder-kept-value"
    captureInheritedCredentials(() => home)
    await mkdir(join(profile, "written-after-capture"))

    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(true)
  })

  // A profile that did not exist when its bearer was kept is pinned by its
  // canonical path, and matches the directory later created there.
  it("hands the kept bearer to a profile directory created after it was kept", async () => {
    const home = join(root, "home")
    const profile = join(root, "profile")
    await mkdir(home)

    process.env.DOMOVOI_PROFILE_DIR = profile
    process.env.DOMOVOI_AUTH_TOKEN = "placeholder-kept-value"
    captureInheritedCredentials(() => home)
    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(true)

    await mkdir(profile)
    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(true)
  })

  // The directory exists, so a canonical path that cannot be read is not a
  // missing profile. Whatever the error, the profile cannot be named and gets
  // nothing, whether its bearer was pinned by path or by inode.
  it.each([
    ["ENOENT", "created after"],
    ["EACCES", "created after"],
    ["ELOOP", "created after"],
    ["ENOENT", "present when"],
    ["EACCES", "present when"],
    ["ELOOP", "present when"],
  ])("hands out no bearer when the canonical path fails with %s after the stat succeeds, for a profile %s its bearer was kept", async (code, when) => {
    const home = join(root, "home")
    const profile = join(root, "profile")
    await mkdir(home)
    if (when === "present when") await mkdir(profile)

    process.env.DOMOVOI_PROFILE_DIR = profile
    process.env.DOMOVOI_AUTH_TOKEN = "placeholder-kept-value"
    captureInheritedCredentials(() => home)
    // Checked before the directory is created: a first match against the
    // created directory would repin a path-pinned bearer by inode.
    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(true)
    if (when === "created after") await mkdir(profile)

    realpathOverrides.set(profile, { code })

    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(false)
  })

  it("hands out no bearer when the stat succeeds but the canonical path no longer matches the one kept", async () => {
    const home = join(root, "home")
    const profile = join(root, "profile")
    await mkdir(home)

    process.env.DOMOVOI_PROFILE_DIR = profile
    process.env.DOMOVOI_AUTH_TOKEN = "placeholder-kept-value"
    captureInheritedCredentials(() => home)
    await mkdir(profile)
    realpathOverrides.set(profile, { path: join(root, "elsewhere") })

    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(false)
  })

  // A profile named by a symlink that is retargeted between the stat and the
  // canonical-path lookup would be pinned by one directory's inode and the
  // other's path. The same switch at lookup would then match that mixed
  // identity and hand the bearer to the directory the link now names.
  it.runIf(process.platform !== "win32")("hands out no bearer when the profile symlink is switched between the stat and the canonical-path lookup", async () => {
    const home = join(root, "home")
    const first = join(root, "first")
    const second = join(root, "second")
    const link = join(root, "profile")
    await mkdir(home)
    await mkdir(first)
    await mkdir(second)
    await symlink(first, link)
    const switchTo = (target: string) => () => {
      rmSync(link)
      symlinkSync(target, link)
    }

    process.env.DOMOVOI_PROFILE_DIR = link
    process.env.DOMOVOI_AUTH_TOKEN = "placeholder-kept-value"
    afterStat.set(link, switchTo(second))
    captureInheritedCredentials(() => home)
    expect(afterStat.has(link)).toBe(false)

    switchTo(first)()
    afterStat.set(link, switchTo(second))
    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(false)
    expect(afterStat.has(link)).toBe(false)
  })

  // The same mixed identity without a race: the canonical path names a
  // directory other than the one the stat saw, or one that cannot be read.
  it.each([
    ["another directory", true],
    ["a path that no longer exists", false],
  ])("hands out no bearer when the canonical path names %s", async (_label, exists) => {
    const home = join(root, "home")
    const profile = join(root, "profile")
    const other = join(root, "other")
    await mkdir(home)
    await mkdir(profile)
    if (exists) await mkdir(other)

    process.env.DOMOVOI_PROFILE_DIR = profile
    process.env.DOMOVOI_AUTH_TOKEN = "placeholder-kept-value"
    realpathOverrides.set(profile, { path: other })
    captureInheritedCredentials(() => home)

    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(false)
  })

  it("forgets every kept bearer on reset", async () => {
    const home = join(root, "home")
    await mkdir(home)
    process.env.DOMOVOI_AUTH_TOKEN = "placeholder-kept-value"
    captureInheritedCredentials(() => home)
    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(true)

    resetKeptCredentialsForTests()

    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(false)
  })
})

// Owner ruling 2026-09-26 (#577, A): the desktop's first module takes the
// values out of process.env itself and holds them until the daemon it ships
// loads, then hands them here. The pinning stays in this one copy.
describe("credentials a caller held and hands over", () => {
  it("keeps values handed in, pinned to the profile process.env names, for a later acquisition", async () => {
    const home = join(root, "home")
    const profile = join(root, "profile")
    await mkdir(home)
    await mkdir(profile)
    process.env.DOMOVOI_PROFILE_DIR = profile

    captureInheritedCredentials(() => home, { DOMOVOI_AUTH_TOKEN: "placeholder-held-value", DOMOVOI_CREDENTIAL_PATH: "/placeholder/credential" })

    const filled = withInheritedCredentials(process.env, home)
    expect(filled.DOMOVOI_AUTH_TOKEN === "placeholder-held-value").toBe(true)
    expect(filled.DOMOVOI_CREDENTIAL_PATH === "/placeholder/credential").toBe(true)
    expect(Object.hasOwn(filled, "DOMOVOI_RELAY_CREDENTIAL_FILE")).toBe(false)
    expect(Object.hasOwn(process.env, "DOMOVOI_AUTH_TOKEN")).toBe(false)
  })

  it("still takes a value left in process.env out of it, and a held value wins over it", async () => {
    const home = join(root, "home")
    await mkdir(home)
    process.env.DOMOVOI_AUTH_TOKEN = "placeholder-environment-value"
    process.env.DOMOVOI_RELAY_CREDENTIAL_FILE = "/placeholder/relay"

    captureInheritedCredentials(() => home, { DOMOVOI_AUTH_TOKEN: "placeholder-held-value" })

    expect(Object.hasOwn(process.env, "DOMOVOI_AUTH_TOKEN")).toBe(false)
    expect(Object.hasOwn(process.env, "DOMOVOI_RELAY_CREDENTIAL_FILE")).toBe(false)
    const filled = withInheritedCredentials(process.env, home)
    expect(filled.DOMOVOI_AUTH_TOKEN === "placeholder-held-value").toBe(true)
    expect(filled.DOMOVOI_RELAY_CREDENTIAL_FILE === "/placeholder/relay").toBe(true)
  })

  it("keeps nothing for an empty hand-over", async () => {
    const home = join(root, "home")
    await mkdir(home)
    captureInheritedCredentials(() => home, { DOMOVOI_AUTH_TOKEN: "" })
    expect(Object.hasOwn(withInheritedCredentials(process.env, home), "DOMOVOI_AUTH_TOKEN")).toBe(false)
  })
})
