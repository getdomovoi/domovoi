import { randomUUID } from "node:crypto"
import { closeSync, fsyncSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { localOwnerRemovalReceiptPath, writeLocalOwnerRemovalReceipt, type LocalOwnerRemovalReceipt } from "./local-owner-removal.js"
import { OperationDeadline } from "./operation-deadline.js"
import { claimProfile, type ProfileLease } from "./profile-lease.js"

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>()
  return { ...fs, closeSync: vi.fn(fs.closeSync), fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync), rmSync: vi.fn(fs.rmSync) }
})
const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
const resources: Array<{ home: string; lease: ProfileLease; deadline: OperationDeadline }> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const { home, lease, deadline } of resources.splice(0)) {
    deadline.clear()
    lease.release()
    actual.rmSync(home, { recursive: true, force: true })
  }
})
function setup() {
  const deadline = OperationDeadline.start(5_000)
  const home = mkdtempSync(join(tmpdir(), "domovoi-receipt-publication-"))
  const lease = claimProfile(home)
  resources.push({ home, lease, deadline })
  const receipt: LocalOwnerRemovalReceipt = {
    version: 1, instanceId: randomUUID(), machineId: `machine-${"a".repeat(32)}`, completedAt: new Date().toISOString(),
    authorization: { kind: "operator", confirmation: "no-supervisor-will-restart", username: "operator" },
  }
  writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline)
  const prior = readFileSync(localOwnerRemovalReceiptPath(home), "utf8")
  return { home, lease, deadline, receipt, prior }
}

it("keeps publication failure primary and names the receipt when staging cleanup also fails", () => {
  const { home, lease, deadline, receipt, prior } = setup()
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("flush failed") })
  vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error("cleanup failed") })
  let failure: unknown
  try { writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline) } catch (error) { failure = error }
  expect(failure).toMatchObject({ message: expect.stringContaining(localOwnerRemovalReceiptPath(home)), cause: expect.any(AggregateError) })
  const causes = (failure as Error & { cause: AggregateError }).cause.errors as Error[]
  expect(causes.map((error) => error.message)).toEqual(["flush failed", "cleanup failed"])
  expect(readFileSync(localOwnerRemovalReceiptPath(home), "utf8")).toBe(prior)
})

it("does not retry closing a descriptor when close reports a failure", () => {
  const { home, lease, deadline, receipt, prior } = setup()
  vi.mocked(closeSync).mockClear().mockImplementationOnce((descriptor) => {
    actual.closeSync(descriptor)
    throw new Error("close failed")
  })
  expect(() => writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline)).toThrow(localOwnerRemovalReceiptPath(home))
  expect(closeSync).toHaveBeenCalledOnce()
  expect(readFileSync(localOwnerRemovalReceiptPath(home), "utf8")).toBe(prior)
})

it("does not publish after flushing spent the original deadline", () => {
  let clock = performance.now()
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  const { home, lease, deadline, receipt, prior } = setup()
  vi.mocked(fsyncSync).mockImplementationOnce((descriptor) => { actual.fsyncSync(descriptor); clock += 5_001 })
  expect(() => writeLocalOwnerRemovalReceipt(home, lease, receipt, deadline)).toThrow(localOwnerRemovalReceiptPath(home))
  expect(readFileSync(localOwnerRemovalReceiptPath(home), "utf8")).toBe(prior)
})

// Windows MoveFileEx refuses to replace a file another process holds open,
// such as a status or removal recovery read of the previous receipt.
it("retries a Windows sharing refusal when replacing the receipt", () => {
  const { home, lease, deadline, receipt } = setup()
  const next = { ...receipt, instanceId: randomUUID() }
  const refusal = (code: string) => () => { throw Object.assign(new Error(`${code}: rename refused`), { code, syscall: "rename" }) }
  vi.mocked(renameSync).mockClear().mockImplementationOnce(refusal("EPERM")).mockImplementationOnce(refusal("EBUSY"))
  // The profile path follows the host; only the replacement behaves as on Windows.
  try {
    writeLocalOwnerRemovalReceipt(home, lease, next, deadline, { platform: "win32" })
    expect(renameSync).toHaveBeenCalledTimes(3)
  } finally { vi.mocked(renameSync).mockReset() }
  expect(JSON.parse(readFileSync(localOwnerRemovalReceiptPath(home), "utf8"))).toEqual(next)
  expect(readdirSync(dirname(localOwnerRemovalReceiptPath(home))).filter((name) => name.endsWith(".partial"))).toEqual([])
})
