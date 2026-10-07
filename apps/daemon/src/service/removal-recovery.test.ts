import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { localOwnerRecordPath, type ReadyLocalOwner } from "../local-owner-record.js"
import { claimProfile, ProfileAlreadyOwnedError } from "../profile-lease.js"
import { callerProfile, createServiceConfiguration, serializeServiceConfiguration, serviceConfigurationPath } from "./configuration.js"
import { removeService, runServiceCommand, type ServiceEffects } from "./install.js"
import { readServiceRemovalSnapshot, serviceRemovalRecovery, type ServiceRemovalSnapshot } from "./removal-recovery.js"
import { removeScratchDirectories } from "../test-scratch.js"

const homes: string[] = []
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await removeScratchDirectories(homes)
})
function snapshots() {
  const registrationId = randomUUID()
  const owner: ReadyLocalOwner = {
    version: 1, state: "ready", instanceId: randomUUID(), machineId: `machine-${"a".repeat(32)}`,
    protocolVersion: "0.4.0", owner: "daemon", credential: { source: "environment" },
    url: "ws://127.0.0.1:47831/rpc", serviceRegistrationId: registrationId,
  }
  const before: ServiceRemovalSnapshot = { owner, registrationId, configurationDigest: "sha256:configuration" }
  return { owner, before, after: structuredClone(before), registrationId }
}
function manager(platform: "linux" | "darwin" | "win32") {
  vi.stubEnv("SystemRoot", "C:\\Windows")
  const { before, after, owner, registrationId } = snapshots()
  const release = vi.fn()
  const effects: ServiceEffects = {
    claimServiceOperation: vi.fn(() => ({ release: vi.fn() })),
    claimProfile: vi.fn(() => ({ release })),
    removalSnapshot: vi.fn().mockImplementationOnce(() => before).mockImplementation(() => after),
    writeRemovalReceipt: vi.fn(), write: vi.fn(async () => {}),
    run: vi.fn(async () => {}), exists: vi.fn(async () => true), remove: vi.fn(async () => {}),
    // Supervised Windows tasks require job proof as well as their action.
    // Q10 B separately permits scheduler retirement of legacy actions.
    ...(platform === "win32"
      ? { stopSupervisor: vi.fn(async () => {}), readConfiguration: vi.fn((home: string) => ({
        ...createServiceConfiguration({}, { platform: "win32", homeDirectory: home, workingDirectory: home }),
        registrationId,
        serviceRuntime: { executable: "C:\\Domovoi\\node.exe", entry: "C:\\Domovoi\\index.js" },
      })) }
      : {}),
    capture: vi.fn(async (command, args) => {
      // Round 2: launchd removal first asks which plist the loaded job came from.
      if (command === "launchctl") return { code: 0, stdout: "\tpath = /home/operator/Library/LaunchAgents/sh.domovoi.domovoid.plist\n\tstate = running\n" }
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le")
      if (script.includes("domovoi-task-action:")) {
        const configurationPath = serviceConfigurationPath("C:\\Users\\operator", "win32")
        const action = { path: "C:\\Domovoi\\node.exe", arguments: `"C:\\Domovoi\\index.js" --service-supervise "${configurationPath}"`, enabled: true, state: 4 }
        return { code: 0, stdout: `domovoi-task-action:${JSON.stringify(action)}` }
      }
      return { code: 0, stdout: script.includes("$folder.DeleteTask(") ? "domovoi-task:deleted" : "domovoi-task:1" }
    }),
  }
  const target = { platform, home: platform === "win32" ? "C:\\Users\\operator" : "/home/operator", uid: 501 }
  return { target, effects, before, after, owner, release }
}

it.each(["linux", "darwin", "win32"] as const)("records the exact stopped instance on %s before releasing the lease", async (platform) => {
  const { target, effects, owner, release } = manager(platform)
  vi.mocked(effects.writeRemovalReceipt).mockImplementation((_home, _lease, receipt, deadline) => {
    expect(release).not.toHaveBeenCalled()
    expect(effects.remove).toHaveBeenCalled()
    if (platform === "win32") expect(effects.stopSupervisor).toHaveBeenCalledOnce()
    expect(deadline.remainingMs()).toBeGreaterThan(0)
    expect(receipt).toMatchObject({ instanceId: owner.instanceId, authorization: { registrationId: owner.serviceRegistrationId } })
  })
  expect(await removeService(target, effects)).toHaveProperty("profileRecovery", "recorded")
  expect(effects.writeRemovalReceipt).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})

it.each(["linux", "darwin", "win32"] as const)("never converts a missing %s job into a removal proof", async (platform) => {
  const { target, effects, owner } = manager(platform)
  if (platform === "win32") vi.mocked(effects.capture).mockResolvedValue({ code: 0, stdout: "domovoi-task:missing" })
  else vi.mocked(effects.run).mockRejectedValueOnce(new Error(platform === "linux" ? "Unit not loaded" : "Could not find service sh.domovoi.domovoid"))
  expect(await removeService(target, effects)).toHaveProperty("profileRecovery", "operator-confirmation-required")
  expect(effects.writeRemovalReceipt).not.toHaveBeenCalled()
  expect(effects.remove).toHaveBeenCalled()
  expect(owner.state).toBe("ready")
})

it("retains Windows configuration without a recovery receipt when a missing task has no tree proof", async () => {
  const { target, effects } = manager("win32")
  vi.mocked(effects.capture).mockResolvedValue({ code: 0, stdout: "domovoi-task:missing" })
  vi.mocked(effects.stopSupervisor!).mockRejectedValue(new Error("Windows tree is unconfirmed. Restart Windows"))
  await expect(removeService(target, effects)).rejects.toThrow("Restart Windows")
  expect(effects.remove).not.toHaveBeenCalled()
  expect(effects.writeRemovalReceipt).not.toHaveBeenCalled()
  expect(effects.claimProfile).not.toHaveBeenCalled()
})

it("receipts the exact legacy instance after scheduler retirement under the lease", async () => {
  const { target, effects, owner, release } = manager("win32"), capture = effects.capture
  effects.capture = vi.fn(async (...args: Parameters<ServiceEffects["capture"]>) => {
    const result = await capture(...args)
    return { ...result, stdout: result.stdout.replace("--service-supervise", "--service-config") }
  })
  vi.mocked(effects.writeRemovalReceipt).mockImplementation((_home, _lease, receipt) => {
    expect(release).not.toHaveBeenCalled()
    const scripts = vi.mocked(effects.capture).mock.calls.map(([, args]) => Buffer.from(args.at(-1)!, "base64").toString("utf16le"))
    expect(scripts.some((s) => s.includes("$task.GetInstances(0).Count"))).toBe(true)
    expect(scripts.at(-1)).toContain("$folder.DeleteTask(")
    expect(effects.remove).toHaveBeenCalled()
    expect(receipt).toMatchObject({ instanceId: owner.instanceId, authorization: { registrationId: owner.serviceRegistrationId } })
  })
  expect(await removeService(target, effects)).toHaveProperty("profileRecovery", "recorded")
  expect(effects.stopSupervisor).not.toHaveBeenCalled()
  expect(effects.writeRemovalReceipt).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})

it.each(["instance", "machine", "registration", "configuration"])("refuses %s drift before deleting saved launch inputs", async (field) => {
  const { target, effects, after, release } = manager("linux")
  if (after.owner?.state !== "ready") throw new Error("Expected a ready test owner")
  if (field === "instance") after.owner.instanceId = randomUUID()
  if (field === "machine") after.owner.machineId = `machine-${"b".repeat(32)}`
  if (field === "registration") after.owner.serviceRegistrationId = randomUUID()
  if (field === "configuration") after.configurationDigest = "sha256:replacement"
  await expect(removeService(target, effects)).rejects.toThrow(/changed during/)
  expect(effects.remove).not.toHaveBeenCalled()
  expect(effects.writeRemovalReceipt).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})

it("requires operator confirmation for an unbound custom owner and tells the CLI user", async () => {
  const { target, effects, before, after } = manager("linux")
  if (before.owner?.state !== "ready" || after.owner?.state !== "ready") throw new Error("Expected ready owners")
  delete before.owner.serviceRegistrationId
  delete after.owner.serviceRegistrationId
  const stdout = vi.fn()
  expect(await runServiceCommand(["service", "remove"], { ...effects, ...target, execPath: "/bin/domovoid", stdout, stderr: vi.fn() })).toBe(0)
  expect(stdout).toHaveBeenCalledWith(expect.stringContaining("domovoid profile recover --confirm-no-supervisor"))
  expect(effects.writeRemovalReceipt).not.toHaveBeenCalled()
})

it("does not create a removal receipt for a different saved registration", () => {
  const { before, after } = snapshots()
  before.registrationId = randomUUID()
  after.registrationId = before.registrationId
  expect(serviceRemovalRecovery(before, after, true)).toHaveProperty("kind", "operator-confirmation-required")
})

it("does not invent an unresolved instance after graceful shutdown", () => {
  const { before, after } = snapshots()
  after.owner = { version: 1, state: "none" }
  expect(serviceRemovalRecovery(before, after, true)).toEqual({ kind: "not-needed" })
})

it("cannot recover while an owner still holds the lease", async () => {
  const { target, effects } = manager("linux")
  vi.mocked(effects.claimProfile).mockImplementation(() => { throw new Error("Profile is still owned") })
  await expect(removeService(target, effects)).rejects.toThrow("still owned")
  expect(effects.remove).not.toHaveBeenCalled()
  expect(effects.writeRemovalReceipt).not.toHaveBeenCalled()
})

it("does not receipt a partial removal or pretend publication succeeded", async () => {
  const failedDelete = manager("linux")
  vi.mocked(failedDelete.effects.remove).mockRejectedValueOnce(new Error("configuration deletion failed"))
  await expect(removeService(failedDelete.target, failedDelete.effects)).rejects.toThrow("configuration deletion failed")
  expect(failedDelete.effects.writeRemovalReceipt).not.toHaveBeenCalled()
  expect(failedDelete.release).toHaveBeenCalledOnce()
  const failedWrite = manager("darwin")
  vi.mocked(failedWrite.effects.writeRemovalReceipt).mockImplementation(() => { throw new Error("receipt publication failed") })
  await expect(removeService(failedWrite.target, failedWrite.effects)).rejects.toThrow("receipt publication failed")
  expect(failedWrite.release).toHaveBeenCalledOnce()
})

it("never writes a receipt for a timed-out removal, even if the last deletion succeeds late", async () => {
  vi.useFakeTimers()
  const { target, effects, release } = manager("linux")
  let finish: (() => void) | undefined
  vi.mocked(effects.remove).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  const result = expect(removeService(target, effects)).rejects.toThrow(/deadline/)
  await vi.advanceTimersByTimeAsync(30_000)
  await result
  expect(finish).toBeTypeOf("function")
  finish!()
  await vi.advanceTimersByTimeAsync(0)
  expect(effects.writeRemovalReceipt).not.toHaveBeenCalled()
  // As in installation, outstanding filesystem work retains the CLI lease
  // until process exit. A timeout is not a safe handoff to another writer.
  expect(release).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

// Security review round 13 of #577 (P3): a legacy Linux service checked from
// a Windows host names its default profile by Linux rules, so the removal
// does not refuse the caller whose profile it is.
it("matches a legacy Linux service's default profile from a Windows host", async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-removal-legacy-"))
  homes.push(home)
  const path = serviceConfigurationPath(home, "linux")
  await mkdir(dirname(path), { recursive: true })
  const configuration = createServiceConfiguration({}, { platform: "linux", homeDirectory: "/home/operator", workingDirectory: "/home/operator" })
  // Legacy: written before service.json named its profile directory.
  const { profileDirectory: _named, ...legacy } = JSON.parse(serializeServiceConfiguration(configuration)) as Record<string, unknown>
  await writeFile(path, JSON.stringify(legacy), { mode: 0o600 })
  const { target, effects } = manager("linux")
  vi.mocked(effects.removalSnapshot).mockReset().mockImplementation(readServiceRemovalSnapshot)
  const real = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...real, value: "win32" })
  try {
    await expect(removeService({ ...target, home }, effects, { callerProfile: callerProfile({}, "/home/operator", "linux") })).resolves.toBeDefined()
  } finally { Object.defineProperty(process, "platform", real) }
})

const cannotDenyRead = process.platform === "win32" || process.getuid?.() === 0
it.each([
  ["truncated owner record", false, async (home: string) => {
    await writeFile(localOwnerRecordPath(home), '{"version":1,"state":"rea', { mode: 0o600 })
  }, /owner record could not be read/],
  ["unreadable owner record", cannotDenyRead, async (home: string) => {
    await writeFile(localOwnerRecordPath(home), '{"version":1,"state":"none"}', { mode: 0o600 })
    await chmod(localOwnerRecordPath(home), 0o000)
  }, /owner record could not be read/],
  ["oversized service configuration", false, async (home: string) => {
    await writeFile(serviceConfigurationPath(home, "linux"), `{"padding":"${"x".repeat(64 * 1_024)}"}`, { mode: 0o600 })
  }, /service configuration .*could not be read/],
] as const)("removes the job without a receipt when the %s blocks proof", async (_name, skip, corrupt, cause) => {
  if (skip) return
  const home = await mkdtemp(join(tmpdir(), "domovoi-removal-snapshot-"))
  homes.push(home)
  await mkdir(join(home, ".domovoi"), { mode: 0o700 })
  await corrupt(home)
  const { effects, release } = manager("linux")
  vi.mocked(effects.removalSnapshot).mockReset().mockImplementation(readServiceRemovalSnapshot)
  const stdout = vi.fn()
  const stderr = vi.fn()
  expect(await runServiceCommand(["service", "remove"], { ...effects, platform: "linux", home, execPath: "/bin/domovoid", stdout, stderr })).toBe(0)
  expect(stderr).not.toHaveBeenCalled()
  expect(effects.run).toHaveBeenCalledWith("systemctl", ["--user", "disable", "--now", "domovoid.service"], expect.anything())
  expect(effects.remove).toHaveBeenCalledWith(serviceConfigurationPath(home, "linux"), expect.anything())
  expect(effects.writeRemovalReceipt).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
  const printed = vi.mocked(stdout).mock.calls.map(([text]) => text).join("")
  expect(printed).toMatch(cause)
  expect(printed).toContain("No recovery receipt was written")
  expect(printed).toContain("domovoid profile recover --confirm-no-supervisor")
})

// T17, found by the packaged smoke (#742): `launchctl bootout` returns while
// the booted-out daemon is still shutting down and still holds the profile
// lease. The stand-in daemon here holds a real lease on a temporary profile
// and lets it go only some time after the bootout, or never.
async function launchdRemoval(options: { releaseAfterBootoutMs?: number; loadedFrom?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "domovoi-removal-launchd-"))
  homes.push(home)
  const plist = join(home, "Library", "LaunchAgents", "sh.domovoi.domovoid.plist")
  const { effects } = manager("darwin")
  const daemon = claimProfile(home)
  const claim = vi.fn(claimProfile)
  effects.claimProfile = claim
  effects.capture = vi.fn(async () => ({ code: 0, stdout: `\tpath = ${options.loadedFrom ?? plist}\n\tstate = running\n` }))
  vi.mocked(effects.run).mockImplementation(async (command, args) => {
    if (command === "launchctl" && args[0] === "bootout" && options.releaseAfterBootoutMs !== undefined) {
      setTimeout(() => daemon.release(), options.releaseAfterBootoutMs)
    }
  })
  return { target: { platform: "darwin" as const, home, uid: 501 }, effects, claim, daemon, plist }
}

it("waits on macOS for the booted-out daemon to let the profile go, then removes the agent", async () => {
  const { target, effects, claim, daemon, plist } = await launchdRemoval({ releaseAfterBootoutMs: 300 })
  try {
    expect(await removeService(target, effects)).toHaveProperty("profileRecovery", "recorded")
    expect(effects.run).toHaveBeenCalledWith("launchctl", ["bootout", "gui/501/sh.domovoi.domovoid"], expect.anything())
    expect(effects.remove).toHaveBeenCalledWith(plist, expect.anything())
    expect(effects.remove).toHaveBeenCalledWith(serviceConfigurationPath(target.home, "darwin"), expect.anything())
    expect(effects.writeRemovalReceipt).toHaveBeenCalledOnce()
    expect(claim.mock.calls.length).toBeGreaterThan(1)
    // The removal let the profile go again once it was done.
    claimProfile(target.home).release()
  } finally { daemon.release() }
})

it("keeps the macOS agent when the booted-out daemon never lets the profile go within the wait", async () => {
  const { target, effects, claim, daemon } = await launchdRemoval()
  try {
    await expect(removeService(target, effects, { profileReleaseWaitMs: 300 })).rejects.toThrow(/profile/)
    expect(claim.mock.calls.length).toBeGreaterThan(1)
    expect(effects.remove).not.toHaveBeenCalled()
    expect(effects.writeRemovalReceipt).not.toHaveBeenCalled()
  } finally { daemon.release() }
})

it("does not wait on macOS when nothing Domovoi loaded was booted out", async () => {
  const { target, effects, claim, daemon } = await launchdRemoval({ releaseAfterBootoutMs: 300, loadedFrom: "/Library/LaunchAgents/other.plist" })
  try {
    await expect(removeService(target, effects)).rejects.toThrow(ProfileAlreadyOwnedError)
    expect(effects.run).not.toHaveBeenCalled()
    expect(claim).toHaveBeenCalledOnce()
    expect(effects.remove).not.toHaveBeenCalled()
  } finally { daemon.release() }
})

it("still claims a Linux profile once after systemd has waited for the stop", async () => {
  const home = await mkdtemp(join(tmpdir(), "domovoi-removal-systemd-"))
  homes.push(home)
  const { effects } = manager("linux")
  const daemon = claimProfile(home)
  const claim = vi.fn(claimProfile)
  effects.claimProfile = claim
  try {
    await expect(removeService({ platform: "linux", home }, effects)).rejects.toThrow(ProfileAlreadyOwnedError)
    expect(claim).toHaveBeenCalledOnce()
    expect(effects.remove).not.toHaveBeenCalled()
  } finally { daemon.release() }
})
