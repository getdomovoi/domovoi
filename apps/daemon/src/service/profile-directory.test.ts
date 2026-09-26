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
  // The runtime is named, as the CLI and the desktop name it, so the install
  // records it and removal can tell the service is Domovoi's.
  const runtime = join(home, process.platform === "win32" ? "node.exe" : "node")
  const execPath = join(home, "domovoid.js")
  const target = { home, platform: process.platform, uid: 1000, user: "domovoi-test", execPath, runtime, configuration }
  const configurationPath = serviceConfigurationPath(home, process.platform)
  // Removal first asks which task action or plist the job runs from (security
  // review rounds 1 and 2); these answer with Domovoi's own.
  // A Windows install first asks whether a task exists (security review
  // round 3); none does until this fixture's /create.
  let registered = false
  const effects = { ...nodeServiceEffects({ userHomeDirectory: home }),
    run: vi.fn(async (_command: string, args: string[]) => { if (args[0] === "/create") registered = true }),
    capture: vi.fn(async (command: string, args: string[]) => {
      if (process.platform === "win32") {
        const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
        if (!registered) return { code: 0, stdout: "domovoi-task:missing" }
        if (script.includes("domovoi-task-action:")) {
          const action = { path: `"${runtime}"`, arguments: `"${execPath}" --service-config "${configurationPath}"`, enabled: true, state: 1 }
          return { code: 0, stdout: `domovoi-task-action:${JSON.stringify(action)}` }
        }
        return { code: 0, stdout: `domovoi-task:${script.includes("DeleteTask") ? "deleted" : "1"}` }
      }
      if (command === "launchctl") return { code: 0, stdout: `\tpath = ${join(home, "Library", "LaunchAgents", "sh.domovoi.domovoid.plist")}\n\tstate = running\n` }
      return { code: 0, stdout: "active" }
    }) }
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
