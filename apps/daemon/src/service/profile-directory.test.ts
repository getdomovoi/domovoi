import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { claimProfile } from "../profile-lease.js"
import { readLocalOwnerRemovalReceipt } from "../local-owner-removal.js"
import { writeLocalOwnerRecord } from "../local-owner-record.js"
import { removeScratchDirectories } from "../test-scratch.js"
import { createServiceConfiguration, parseServiceConfiguration, serviceConfigurationPath, serviceRegistrationBlocksProfile } from "./configuration.js"
import { installService, nodeServiceEffects, removeService } from "./install.js"

const roots: string[] = []
afterEach(async () => { await removeScratchDirectories(roots) })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "domovoi-service-profile-"))
  roots.push(home)
  const profileDirectory = join(home, "profiles", "chosen")
  const configuration = createServiceConfiguration({ DOMOVOI_PROFILE_DIR: profileDirectory }, {
    homeDirectory: home, workingDirectory: home, platform: process.platform,
  })
  const target = { home, platform: process.platform, uid: 1000, user: "domovoi-test", execPath: join(home, "domovoid"), configuration }
  const effects = { ...nodeServiceEffects({ userHomeDirectory: home }), run: vi.fn(async () => {}),
    capture: vi.fn(async (_command: string, args: string[]) => ({ code: 0,
      stdout: process.platform === "win32"
        ? `domovoi-task:${Buffer.from(args.at(-1)!, "base64").toString("utf16le").includes("DeleteTask") ? "deleted" : "1"}`
        : "active",
    })) }
  return { home, profileDirectory, target, effects }
}

it("keeps registration per user and removes the configured profile without a shell override", async () => {
  const f = await fixture()
  await installService(f.target, f.effects)
  const path = serviceConfigurationPath(f.home, process.platform)
  const saved = parseServiceConfiguration(await readFile(path, "utf8"))
  expect(saved.profileDirectory).toBe(f.profileDirectory)
  expect(serviceRegistrationBlocksProfile(f.home, { profileDirectory: f.profileDirectory })).toBe(true)
  expect(serviceRegistrationBlocksProfile(f.home, f.home)).toBe(false)
  const instanceId = randomUUID()
  writeLocalOwnerRecord({ profileDirectory: f.profileDirectory }, {
    version: 1, state: "starting", owner: "daemon", instanceId,
    machineId: `machine-${"a".repeat(32)}`, protocolVersion: "0.4.0",
    serviceRegistrationId: saved.registrationId!, credential: { source: "environment" },
  })
  const removed = await removeService({ home: f.home, platform: process.platform, uid: 1000 }, f.effects)
  expect(removed.profileRecovery).toBe("recorded")
  expect(readLocalOwnerRemovalReceipt({ profileDirectory: f.profileDirectory })).toMatchObject({ instanceId })
  expect(readLocalOwnerRemovalReceipt(f.home)).toBeUndefined()
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
})

it("cannot replace a live registered profile by installing another profile", async () => {
  const f = await fixture()
  await installService(f.target, f.effects)
  const original = await readFile(serviceConfigurationPath(f.home, process.platform), "utf8")
  const lease = claimProfile({ profileDirectory: f.profileDirectory })
  try {
    const configuration = createServiceConfiguration({ DOMOVOI_PROFILE_DIR: join(f.home, "other") }, {
      homeDirectory: f.home, workingDirectory: f.home, platform: process.platform,
    })
    await expect(installService({ ...f.target, configuration }, f.effects)).rejects.toThrow(/already owned/)
    expect(await readFile(serviceConfigurationPath(f.home, process.platform), "utf8")).toBe(original)
  } finally { lease.release() }
})

it("serializes service operations across profile choices", async () => {
  const f = await fixture()
  const lease = f.effects.claimServiceOperation()
  try { await expect(installService(f.target, f.effects)).rejects.toThrow(/Another Domovoi service operation/) }
  finally { lease.release() }
})

it("recognizes a registered profile through a directory alias", async () => {
  const f = await fixture()
  await installService(f.target, f.effects)
  const alias = join(f.home, "profile-alias")
  await symlink(f.profileDirectory, alias, process.platform === "win32" ? "junction" : "dir")
  expect(serviceRegistrationBlocksProfile(f.home, { profileDirectory: alias })).toBe(true)
  const configuration = createServiceConfiguration({ DOMOVOI_PROFILE_DIR: alias }, {
    homeDirectory: f.home, workingDirectory: f.home, platform: process.platform,
  })
  await expect(installService({ ...f.target, configuration }, f.effects)).resolves.toBeDefined()
})
