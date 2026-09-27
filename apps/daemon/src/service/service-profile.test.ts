import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

// A read the test fails for one path with a chosen code, standing in for a
// service.json whose directory cannot be searched. Other paths read as usual.
const failingReads = vi.hoisted(() => new Map<string, string>())
vi.mock("../local-owner-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../local-owner-record.js")>()
  return {
    ...actual,
    readLocalProfileFile: (path: string, maximumBytes: number, privateFile?: boolean) => {
      const code = failingReads.get(path)
      if (code !== undefined) throw Object.assign(new Error(`${code}: injected by the test`), { code })
      return actual.readLocalProfileFile(path, maximumBytes, privateFile)
    },
  }
})

import { removeScratchDirectories } from "../test-scratch.js"
import { readServiceRemovalSnapshot } from "./removal-recovery.js"
import { createServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath, serviceProfileMismatch } from "./configuration.js"

const roots: string[] = []
afterEach(async () => {
  failingReads.clear()
  await removeScratchDirectories(roots)
})

async function home(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "domovoi-service-profile-match-")))
  roots.push(root)
  return root
}

async function saveService(homeDirectory: string, environment: Record<string, string>): Promise<void> {
  const path = serviceConfigurationPath(homeDirectory, process.platform)
  await mkdir(dirname(path), { recursive: true })
  const configuration = createServiceConfiguration(environment, { homeDirectory, workingDirectory: homeDirectory, platform: process.platform })
  await writeFile(path, serializeServiceConfiguration(configuration), { mode: 0o600 })
}

// Security review of #577 (P1): the desktop checks and fences the daemon its
// own environment names, while the service calls act on the service the saved
// configuration names. When DOMOVOI_PROFILE_DIR makes those two profiles, the
// check says nothing about the service, so the desktop refuses.
describe("serviceProfileMismatch", () => {
  it("matches the default profile when nothing is saved and the environment names none", async () => {
    const root = await home()
    expect(serviceProfileMismatch({ environment: {}, homeDirectory: root })).toBeUndefined()
  })

  // Security review round 2 of #577 (P1): an install from the desktop writes
  // the app's own profile, so with no saved service any profile matches.
  it("matches any profile the environment names when no service is saved", async () => {
    const root = await home()
    expect(serviceProfileMismatch({ environment: { DOMOVOI_PROFILE_DIR: join(root, "profiles", "other") }, homeDirectory: root })).toBeUndefined()
  })

  it("matches the profile the saved configuration names, and names both when the environment names another", async () => {
    const root = await home()
    const chosen = join(root, "profiles", "chosen")
    await saveService(root, { DOMOVOI_PROFILE_DIR: chosen })
    expect(serviceProfileMismatch({ environment: { DOMOVOI_PROFILE_DIR: chosen }, homeDirectory: root })).toBeUndefined()
    expect(serviceProfileMismatch({ environment: {}, homeDirectory: root })).toEqual({ app: join(root, ".domovoi"), service: chosen })
  })

  it("throws when the saved configuration cannot be read", async () => {
    const root = await home()
    const path = serviceConfigurationPath(root, process.platform)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, "not a configuration", { mode: 0o600 })
    expect(() => serviceProfileMismatch({ environment: {}, homeDirectory: root })).toThrow()
  })

  // Security review round 2 of #577 (P2): only a service.json that is not
  // there counts as none saved; one that cannot be read is not known.
  it("throws when service.json cannot be reached, and reads a missing one as none saved", async () => {
    const root = await home()
    const path = serviceConfigurationPath(root, process.platform)
    failingReads.set(path, "EACCES")
    expect(() => serviceProfileMismatch({ environment: {}, homeDirectory: root })).toThrow(/EACCES/)
    failingReads.set(path, "ENOENT")
    expect(serviceProfileMismatch({ environment: {}, homeDirectory: root })).toBeUndefined()
  })
})

// Security review round 3 of #577 (P2): the removal snapshot is the one read
// of service.json a removal checks and acts on. A file there that cannot be
// read or parsed names no profile, and the snapshot says so.
describe("readServiceRemovalSnapshot", () => {
  it("marks a saved configuration it cannot parse as naming no known profile", async () => {
    const root = await home()
    const path = serviceConfigurationPath(root, process.platform)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, "not a configuration", { mode: 0o600 })
    expect(readServiceRemovalSnapshot(root, process.platform).configurationUnknown).toMatch(/^The saved service configuration at .+ is not a Domovoi service configuration\.$/u)
  })

  it("marks one it cannot read, and not a missing one", async () => {
    const root = await home()
    const path = serviceConfigurationPath(root, process.platform)
    failingReads.set(path, "EACCES")
    expect(readServiceRemovalSnapshot(root, process.platform).configurationUnknown).toMatch(/could not be read: .*EACCES/u)
    failingReads.set(path, "ENOENT")
    expect(readServiceRemovalSnapshot(root, process.platform).configurationUnknown).toBeUndefined()
  })

  // Round 4 (P1): the effective profile comes from the saved configuration's
  // own home, not the home the removal was asked from.
  it("names the effective profile under the saved configuration's own home", async () => {
    const root = await home()
    const otherHome = join(root, "other-home")
    await mkdir(otherHome)
    const path = serviceConfigurationPath(root, process.platform)
    await mkdir(dirname(path), { recursive: true })
    const configuration = createServiceConfiguration({}, { homeDirectory: otherHome, workingDirectory: otherHome, platform: process.platform })
    await writeFile(path, serializeServiceConfiguration(configuration), { mode: 0o600 })
    expect(readServiceRemovalSnapshot(root, process.platform).effectiveProfileDirectory).toBe(join(otherHome, ".domovoi"))
  })
})
