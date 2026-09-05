import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { localOwnerRecordPath, type ReadyLocalOwner } from "../local-owner-record.js"
import { serviceConfigurationPath } from "./configuration.js"
import { removeService, runServiceCommand, type ServiceEffects } from "./install.js"
import { readServiceRemovalSnapshot, serviceRemovalRecovery, type ServiceRemovalSnapshot } from "./removal-recovery.js"

const homes: string[] = []
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
function snapshots() {
  const registrationId = randomUUID()
  const owner: ReadyLocalOwner = {
    version: 1, state: "ready", instanceId: randomUUID(), machineId: `machine-${"a".repeat(32)}`,
    protocolVersion: "0.4.0", owner: "daemon", credential: { source: "environment" },
    url: "ws://127.0.0.1:47831/rpc", serviceRegistrationId: registrationId,
  }
  const before: ServiceRemovalSnapshot = { owner, registrationId, configurationDigest: "sha256:configuration" }
  return { owner, before, after: structuredClone(before) }
}
function manager(platform: "linux" | "darwin" | "win32") {
  vi.stubEnv("SystemRoot", "C:\\Windows")
  const { before, after, owner } = snapshots()
  const release = vi.fn()
  const effects: ServiceEffects = {
    claimProfile: vi.fn(() => ({ release })),
    removalSnapshot: vi.fn().mockImplementationOnce(() => before).mockImplementation(() => after),
    writeRemovalReceipt: vi.fn(), write: vi.fn(async () => {}),
    run: vi.fn(async () => {}), exists: vi.fn(async () => true), remove: vi.fn(async () => {}),
    capture: vi.fn(async (_command, args) => ({
      code: 0,
      stdout: Buffer.from(args.at(-1)!, "base64").toString("utf16le").includes("$folder.DeleteTask(")
        ? "domovoi-task:deleted" : "domovoi-task:1",
    })),
  }
  const target = { platform, home: platform === "win32" ? "C:\\Users\\operator" : "/home/operator", uid: 501 }
  return { target, effects, before, after, owner, release }
}

it.each(["linux", "darwin", "win32"] as const)("records the exact stopped instance on %s before releasing the lease", async (platform) => {
  const { target, effects, owner, release } = manager(platform)
  vi.mocked(effects.writeRemovalReceipt).mockImplementation((_home, _lease, receipt, deadline) => {
    expect(release).not.toHaveBeenCalled()
    expect(effects.remove).toHaveBeenCalled()
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
