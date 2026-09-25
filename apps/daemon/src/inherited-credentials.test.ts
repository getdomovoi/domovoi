import type { BigIntStats, PathLike, StatSyncOptions, Stats } from "node:fs"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A stat the test controls for one path, so a directory can report the device
// and inode another directory had. On ext4 a new directory can get the inode
// number of one just deleted; this stands in for that without depending on
// the filesystem to reuse it.
const statOverrides = vi.hoisted(() => new Map<string, { dev: bigint; ino: bigint }>())

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const statSync = ((path: PathLike, options?: StatSyncOptions) => {
    const stats = actual.statSync(path, options)
    const override = statOverrides.get(resolve(String(path)))
    if (override === undefined || stats === undefined) return stats
    return Object.assign(stats as BigIntStats | Stats, override)
  }) as typeof actual.statSync
  return { ...actual, statSync, default: { ...actual, statSync } }
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
