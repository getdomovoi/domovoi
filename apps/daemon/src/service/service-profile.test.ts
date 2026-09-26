import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { removeScratchDirectories } from "../test-scratch.js"
import { createServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath, serviceProfileMismatch } from "./configuration.js"

const roots: string[] = []
afterEach(async () => { await removeScratchDirectories(roots) })

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

  it("names both profiles when the environment names another profile than an install would write", async () => {
    const root = await home()
    const other = join(root, "profiles", "other")
    expect(serviceProfileMismatch({ environment: { DOMOVOI_PROFILE_DIR: other }, homeDirectory: root }))
      .toEqual({ app: other, service: join(root, ".domovoi") })
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
})
