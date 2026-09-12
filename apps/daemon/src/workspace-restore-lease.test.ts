import { execFile, type ChildProcess, type PromiseWithChild } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { removeScratchDirectories } from "./test-scratch.js"
import { RestoreOperationLease, trackRestoreCommand } from "./workspace-restore-lease.js"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const directories: string[] = []
const execute = promisify(execFile)
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(renameSync).mockReset(); await removeScratchDirectories(directories) })

async function abandonedClaim(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "domovoi-restore-owner-"))
  directories.push(root)
  const token = randomUUID()
  const claimPath = join(root, ".restore-claims", "session-test")
  const ownerPath = join(root, ".restore-leases", "session-test.json")
  await mkdir(join(root, ".restore-claims"))
  await mkdir(join(root, ".restore-leases"))
  await writeFile(claimPath, token)
  await writeFile(ownerPath, JSON.stringify({ version: 2, token, ownerPid: 12345, descendantsUnknown: false, starting: 0, children: [], ...overrides }))
  return { root, token, claimPath, ownerPath }
}

function noSuchProcess() { return Object.assign(new Error("No such process"), { code: "ESRCH" }) }

describe("restore owner reclamation", () => {
  it.each([
    { label: "live owner", overrides: {}, alive: [12345], reason: "owner is still alive" },
    { label: "live child", overrides: { children: [23456] }, alive: [23456], reason: "Git child 23456 is still alive" },
    { label: "unrecorded launch", overrides: { starting: 1 }, alive: [], reason: "Git launch was not fully recorded" },
    { label: "different token", overrides: { token: randomUUID() }, alive: [], reason: "token does not match" },
    { label: "malformed owner", overrides: { children: [-1] }, alive: [], reason: "no readable recovery record" },
    { label: "legacy owner record", overrides: { version: 1 }, alive: [], reason: "no readable recovery record" },
    { label: "interrupted child", overrides: { descendantsUnknown: true }, alive: [], reason: "descendant liveness is unknown" },
  ])("preserves a claim with a $label", async ({ overrides, alive, reason }) => {
    const f = await abandonedClaim(overrides)
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (alive.some((living) => living === pid)) return true
      throw noSuchProcess()
    })
    expect(() => new RestoreOperationLease(f.root, "session-test", randomUUID())).toThrow(reason)
    expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true)
    await expect(readFile(f.claimPath, "utf8")).resolves.toBe(f.token)
  })

  it.each(["EPERM", "EIO", "EINVAL"])("refuses %s from a process probe rather than claiming death", async (code) => {
    const f = await abandonedClaim()
    const failure = Object.assign(new Error("Cannot inspect process"), { code })
    vi.spyOn(process, "kill").mockImplementation(() => { throw failure })
    expect(() => new RestoreOperationLease(f.root, "session-test", randomUUID())).toThrow(failure)
    await expect(readFile(f.claimPath, "utf8")).resolves.toBe(f.token)
  })

  it("preserves a claim when absent launchers have no recorded settlement", async () => {
    const f = await abandonedClaim({ children: [23456, 34567] })
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw noSuchProcess() })
    expect(() => new RestoreOperationLease(f.root, "session-test", randomUUID())).toThrow("descendant liveness is unknown")
    expect(kill.mock.calls).toEqual([[12345, 0], [23456, 0], [34567, 0]])
    await expect(readFile(f.claimPath, "utf8")).resolves.toBe(f.token)
  })

  it("reclaims after owner death only when every Git settlement was recorded", async () => {
    const f = await abandonedClaim()
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw noSuchProcess() })
    const lease = new RestoreOperationLease(f.root, "session-test", randomUUID())
    try {
      expect(kill.mock.calls).toEqual([[12345, 0]])
      await expect(readFile(f.claimPath)).rejects.toMatchObject({ code: "ENOENT" })
    } finally { lease.release() }
  })

  it.each([
    { label: "signaled exit", signal: "SIGTERM", killed: false, errorName: "Error" },
    { label: "abort without an exit signal", signal: null, killed: false, errorName: "AbortError" },
    { label: "owned termination without an exit signal", signal: null, killed: true, errorName: "Error" },
  ])("keeps child identity until close and preserves uncertainty after $label", async ({ signal, killed, errorName }) => {
    const f = await abandonedClaim()
    vi.spyOn(process, "kill").mockImplementation(() => { throw noSuchProcess() })
    const lease = new RestoreOperationLease(f.root, "session-test", randomUUID())
    const child = new EventEmitter() as ChildProcess
    Object.defineProperty(child, "pid", { value: 45678 })
    Object.defineProperty(child, "killed", { value: killed })
    const failure = new Error("aborted before child close")
    failure.name = errorName
    const pending = Object.assign(Promise.reject(failure), { child }) as PromiseWithChild<never>
    const result = lease.run(() => trackRestoreCommand(() => pending))
    let settled = false
    const observed = result.then(() => { settled = true }, () => { settled = true })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(JSON.parse(await readFile(f.ownerPath, "utf8"))).toMatchObject({ starting: 0, children: [45678] })
      expect(() => new RestoreOperationLease(f.root, "session-test", randomUUID())).toThrow("operation lease")
      child.emit("close", null, signal)
      await expect(result).rejects.toBe(failure)
      expect(JSON.parse(await readFile(f.ownerPath, "utf8"))).toMatchObject({ starting: 0, children: [], descendantsUnknown: true })
      expect(() => lease.assertRecordedSettlement()).toThrow("descendant liveness is unknown")
      const laterLaunch = vi.fn<() => PromiseWithChild<never>>(() => { throw new Error("Cleanup started a new Git command") })
      await expect(lease.run(() => trackRestoreCommand(laterLaunch))).rejects.toThrow("descendant liveness is unknown")
      expect(laterLaunch).not.toHaveBeenCalled()
    } finally {
      child.emit("close", null, signal)
      await observed
      lease.release()
    }
  })

  it("records every concurrently running child rather than only the latest PID", async () => {
    const f = await abandonedClaim()
    // This case needs no stale marker and runs actual bounded child processes.
    const root = join(f.root, "fresh")
    const lease = new RestoreOperationLease(root, "session-test", randomUUID())
    const ownerPath = join(root, ".restore-leases", "session-test.json")
    const children: Array<PromiseWithChild<{ stdout: string; stderr: string }>> = []
    const results = [0, 1].map(() => lease.run(() => trackRestoreCommand(() => {
      const child = execute(process.execPath, ["-e", "process.stdin.resume(); process.stdin.once('data', () => process.exit(0))"], { timeout: 10_000 })
      children.push(child)
      return child
    })))
    const settled = Promise.allSettled(results)
    try {
      const record = JSON.parse(await readFile(ownerPath, "utf8")) as { children: number[] }
      expect(record.children).toEqual(children.map(({ child }) => child.pid))
      expect(record.children).toHaveLength(2)
      for (const { child } of children) child.stdin!.end("finish")
      expect((await settled).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"])
    } finally {
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await settled
      lease.release()
    }
  })

  it("waits for a sibling child after Promise.all rejects early", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-restore-sibling-"))
    directories.push(root)
    const lease = new RestoreOperationLease(root, "session-test", randomUUID())
    const failedChild = new EventEmitter() as ChildProcess
    const sibling = new EventEmitter() as ChildProcess
    Object.defineProperty(failedChild, "pid", { value: 45678 })
    Object.defineProperty(sibling, "pid", { value: 56789 })
    const failure = new Error("First Git query failed")
    const failed = Object.assign(Promise.reject(failure), { child: failedChild }) as PromiseWithChild<never>
    let finishSibling!: () => void
    const pending = Object.assign(new Promise<void>((resolve) => { finishSibling = resolve }), { child: sibling }) as PromiseWithChild<void>
    const result = lease.run(() => Promise.all([
      trackRestoreCommand(() => failed),
      trackRestoreCommand(() => pending),
    ]))
    let settled = false
    const observed = result.then(() => { settled = true }, () => { settled = true })
    failedChild.emit("close", 1, null)
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(JSON.parse(await readFile(join(root, ".restore-leases", "session-test.json"), "utf8")))
        .toMatchObject({ starting: 0, children: [56789] })
      finishSibling()
      sibling.emit("close", 0, null)
      await expect(result).rejects.toBe(failure)
      // An ordinary nonzero Git result is not an interrupted process exit.
      // Queries use nonzero statuses to report absent refs and other refusals.
      expect(() => lease.assertRecordedSettlement()).not.toThrow()
    } finally {
      finishSibling()
      sibling.emit("close", 0, null)
      await observed
      lease.release()
    }
  })

  it("preserves command failure when recording its exit also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "domovoi-restore-record-failure-"))
    directories.push(root)
    const lease = new RestoreOperationLease(root, "session-test", randomUUID())
    const child = new EventEmitter() as ChildProcess
    Object.defineProperty(child, "pid", { value: 45678 })
    const primary = new Error("Git could not read the repository")
    const cleanup = Object.assign(new Error("Cannot record Git exit"), { code: "EIO" })
    const pending = Object.assign(Promise.reject(primary), { child }) as PromiseWithChild<never>
    const result = lease.run(() => trackRestoreCommand(() => pending))
    const observed = result.catch((error: unknown) => error)
    vi.mocked(renameSync).mockImplementationOnce(() => { throw cleanup })
    child.emit("close", 1, null)
    try {
      expect(await observed).toMatchObject({ name: "AggregateError", errors: [primary, cleanup], cause: primary })
    } finally { lease.release() }
  })
})
