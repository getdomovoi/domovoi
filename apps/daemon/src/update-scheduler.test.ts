import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { afterEach, expect, it, vi } from "vitest"
import type { UpdateStatus } from "@getdomovoi/protocol"

import { claimProfile, type ProfileLease } from "./profile-lease.js"
import { DaemonUpdates, storedUpdatePolicySchema } from "./update-dispatch.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { automaticUpdateCheckIntervalMs, UpdateScheduler } from "./update-scheduler.js"
import * as verification from "./update-verification.js"
import { DomovoiDaemon } from "./server.js"
import { FileTransferTransactions } from "./transfer-transactions.js"

const homes: string[] = []
const leases: ProfileLease[] = []
const schedulers: UpdateScheduler[] = []
const daemons: DomovoiDaemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const scheduler of schedulers.splice(0)) await scheduler.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const lease of leases.splice(0)) lease.release()
  await removeScratchDirectories(homes)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

const status: UpdateStatus = { channel: "stable", currentVersion: "0.0.1", state: "idle" }
const keyid = "a".repeat(64)
// Schema-valid public metadata only. Admission tests do not claim verification.
const policy = storedUpdatePolicySchema.parse({
  format: 1, channel: "stable", automaticChecks: true,
  metadataBaseUrl: "https://updates.example.test/metadata/",
  artifactBaseUrl: "https://updates.example.test/artifacts/",
  trustedRoot: {
    signed: {
      _type: "root", spec_version: "1.0.31", version: 1, consistent_snapshot: true,
      expires: "2099-01-01T00:00:00.000Z",
      keys: { [keyid]: { keytype: "ed25519", scheme: "ed25519", keyval: { public: "b".repeat(64) } } },
      roles: Object.fromEntries(["root", "targets", "timestamp", "snapshot"].map((role) => [role, { keyids: [keyid], threshold: 1 }])),
    },
    signatures: [{ keyid, sig: "c".repeat(128) }],
  },
})

async function fixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "domovoi-update-scheduler-"))
  homes.push(homeDirectory)
  const lease = claimProfile(homeDirectory)
  leases.push(lease)
  const policyPath = join(homeDirectory, ".domovoi", "update-policy.json")
  const save = (value: unknown = policy) => writeFile(policyPath, JSON.stringify(value), { mode: 0o600 })
  await save()
  const check = vi.fn(async () => status)
  const options = { homeDirectory, lease }
  const scheduler = new UpdateScheduler(options, { check })
  schedulers.push(scheduler)
  vi.useFakeTimers()
  return { options, policyPath, save, check, scheduler }
}

it("checks the explicitly authorized channel only after start and the interval", async () => {
  const { check, scheduler } = await fixture()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).not.toHaveBeenCalled()
  scheduler.start()
  scheduler.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs - 1)
  expect(check).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(check).toHaveBeenCalledExactlyOnceWith({ channel: "stable" })
})

it.each(["missing", "disabled", "malformed", "directory", "unsupported-channel", "non-boolean", "untrusted-url", "missing-root", "oversize"])("refuses %s policy and recovers at a later valid boundary", async (kind) => {
  const { check, scheduler, policyPath, save } = await fixture()
  if (kind === "missing" || kind === "directory") await rm(policyPath)
  if (kind === "directory") await mkdir(policyPath)
  if (kind === "disabled") await save({ ...policy, automaticChecks: false })
  if (kind === "malformed") await writeFile(policyPath, "{")
  if (kind === "unsupported-channel") await save({ ...policy, channel: "internal" })
  if (kind === "non-boolean") await save({ ...policy, automaticChecks: "true" })
  if (kind === "untrusted-url") await save({ ...policy, metadataBaseUrl: "http://updates.example.test" })
  if (kind === "missing-root") await save({ ...policy, trustedRoot: undefined })
  if (kind === "oversize") await writeFile(policyPath, " ".repeat(verification.maximumUpdateMetadataBytes + 1))
  scheduler.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).not.toHaveBeenCalled()
  if (kind === "directory") await rm(policyPath, { recursive: true })
  await save()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).toHaveBeenCalledExactlyOnceWith({ channel: "stable" })
})

it.skipIf(process.platform === "win32")("refuses a non-private policy file", async () => {
  const { check, scheduler, policyPath } = await fixture()
  await chmod(policyPath, 0o644)
  scheduler.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).not.toHaveBeenCalled()
})

it("rereads authorization and channel instead of retaining the last admission", async () => {
  const { check, scheduler, save, policyPath } = await fixture()
  scheduler.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  await save({ ...policy, channel: "beta" })
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check.mock.calls).toEqual([[{ channel: "stable" }], [{ channel: "beta" }]])
  await save({ ...policy, automaticChecks: false })
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  await rm(policyPath)
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).toHaveBeenCalledTimes(2)
})

it("lets admitted work finish after revocation, without overlap or catch-up checks", async () => {
  const { check, scheduler, save } = await fixture()
  const admitted = deferred<UpdateStatus>()
  check.mockReturnValueOnce(admitted.promise)
  scheduler.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).toHaveBeenCalledTimes(1)
  await save({ ...policy, automaticChecks: false })
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs * 3)
  expect(check).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  admitted.resolve(status)
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).toHaveBeenCalledTimes(1)
})

it("clears the timer synchronously and cannot restart after stop", async () => {
  const { check, scheduler } = await fixture()
  scheduler.start()
  expect(vi.getTimerCount()).toBe(1)
  const stopped = scheduler.stop()
  expect(vi.getTimerCount()).toBe(0)
  scheduler.start()
  await stopped
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs * 2)
  expect(check).not.toHaveBeenCalled()
})

it("fences an already queued cycle when stop runs before its admission", async () => {
  const { check, scheduler } = await fixture()
  scheduler.start()
  vi.advanceTimersByTime(automaticUpdateCheckIntervalMs)
  await scheduler.stop()
  expect(check).not.toHaveBeenCalled()
})

it("drains a check that synchronously calls stop and never schedules again", async () => {
  const { check, scheduler } = await fixture()
  const admitted = deferred<UpdateStatus>()
  const finished = vi.fn()
  check.mockImplementationOnce(() => {
    void scheduler.stop().then(finished)
    return admitted.promise
  })
  scheduler.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).toHaveBeenCalledTimes(1)
  expect(finished).not.toHaveBeenCalled()
  admitted.resolve(status)
  await scheduler.stop()
  expect(finished).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).toHaveBeenCalledTimes(1)
})

it.each(["throw", "reject"])("contains check %s and reevaluates at the next boundary", async (failure) => {
  const { check, scheduler } = await fixture()
  if (failure === "throw") check.mockImplementationOnce(() => { throw new Error("synthetic") })
  else check.mockRejectedValueOnce(new Error("synthetic"))
  scheduler.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs * 2)
  expect(check).toHaveBeenCalledTimes(2)
})

it("does not admit after losing the profile lease", async () => {
  const { check, scheduler, options } = await fixture()
  scheduler.start()
  options.lease.release()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).not.toHaveBeenCalled()
})

it("shares an admitted manual check and preserves competing-channel refusal", async () => {
  const { options } = await fixture()
  const fetched = deferred<never>()
  const verify = vi.spyOn(verification, "fetchUpdateMetadata").mockReturnValueOnce(fetched.promise)
  const updates = new DaemonUpdates(options)
  const scheduler = new UpdateScheduler(options, updates)
  schedulers.push(scheduler)
  const manual = updates.check({ channel: "stable" })
  await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce(), { timeout: 1000 })
  scheduler.start()
  try {
    await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs * 3)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(await updates.check({ channel: "beta" })).toMatchObject({ refusal: { reason: "busy" } })
    const finished = vi.fn()
    const stopped = scheduler.stop().then(finished)
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).not.toHaveBeenCalled()
    fetched.reject(new verification.UpdateVerificationError("network", "synthetic"))
    await stopped
    expect(await manual).toMatchObject({ state: "failed", refusal: { reason: "network" } })
    await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
    expect(verify).toHaveBeenCalledTimes(1)
  } finally {
    fetched.reject(new verification.UpdateVerificationError("network", "cleanup"))
    await updates.stop()
  }
})

it("uses stored channel after a manual check changed updater status", async () => {
  const { options } = await fixture()
  vi.spyOn(verification, "fetchUpdateMetadata").mockRejectedValue(new verification.UpdateVerificationError("network", "synthetic"))
  const updates = new DaemonUpdates(options)
  await updates.check({ channel: "beta" })
  expect(updates.status().channel).toBe("beta")
  const scheduler = new UpdateScheduler(options, updates)
  schedulers.push(scheduler)
  scheduler.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  await scheduler.stop()
  expect(updates.status().channel).toBe("stable")
})

it("starts scheduling only after the daemon starts and stops it with the daemon", async () => {
  const { options } = await fixture()
  const check = vi.spyOn(DaemonUpdates.prototype, "check").mockResolvedValue(status)
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", updates: options })
  daemons.push(daemon)
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).not.toHaveBeenCalled()
  await daemon.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).toHaveBeenCalledExactlyOnceWith({ channel: "stable" })
  await daemon.stop()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs * 2)
  expect(check).toHaveBeenCalledTimes(1)
})

it("does not schedule without explicit updater options", async () => {
  vi.useFakeTimers()
  const check = vi.spyOn(DaemonUpdates.prototype, "check").mockResolvedValue(status)
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:" })
  daemons.push(daemon)
  await daemon.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).not.toHaveBeenCalled()
})

it("does not schedule after startup abort or listener failure", async () => {
  const { options } = await fixture()
  const check = vi.spyOn(DaemonUpdates.prototype, "check").mockResolvedValue(status)
  const aborted = new DomovoiDaemon({ port: 0, statePath: ":memory:", updates: options })
  daemons.push(aborted)
  await expect(aborted.start(AbortSignal.abort())).rejects.toThrow()
  const occupied = createServer()
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve))
  try {
    const address = occupied.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    const failed = new DomovoiDaemon({ port: address.port, statePath: ":memory:", updates: options })
    daemons.push(failed)
    await expect(failed.start()).rejects.toMatchObject({ code: "EADDRINUSE" })
    await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
    expect(check).not.toHaveBeenCalled()
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()))
  }
})

it("never admits while startup is pending or after it aborts during recovery", async () => {
  const { options } = await fixture()
  const recovery = deferred<string[]>()
  vi.spyOn(FileTransferTransactions.prototype, "pruneExpired").mockReturnValue(recovery.promise)
  const check = vi.spyOn(DaemonUpdates.prototype, "check").mockResolvedValue(status)
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", updates: options })
  daemons.push(daemon)
  const abort = new AbortController()
  const starting = daemon.start(abort.signal)
  const refused = expect(starting).rejects.toThrow("Cancelled startup")
  try {
    await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
    expect(check).not.toHaveBeenCalled()
    abort.abort(new Error("Cancelled startup"))
  } finally {
    recovery.resolve([])
  }
  await refused
  await daemon.stop()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).not.toHaveBeenCalled()
})

it("keeps daemon shutdown pending until an admitted scheduled check finishes", async () => {
  const { options } = await fixture()
  const admitted = deferred<UpdateStatus>()
  const check = vi.spyOn(DaemonUpdates.prototype, "check").mockReturnValue(admitted.promise)
  const daemon = new DomovoiDaemon({ port: 0, statePath: ":memory:", updates: options })
  daemons.push(daemon)
  await daemon.start()
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).toHaveBeenCalledOnce()
  const finished = vi.fn()
  const stopping = daemon.stop().then(finished)
  try {
    await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs * 2)
    expect(finished).not.toHaveBeenCalled()
    expect(check).toHaveBeenCalledTimes(1)
  } finally {
    admitted.resolve(status)
  }
  await stopping
  await vi.advanceTimersByTimeAsync(automaticUpdateCheckIntervalMs)
  expect(check).toHaveBeenCalledTimes(1)
})
